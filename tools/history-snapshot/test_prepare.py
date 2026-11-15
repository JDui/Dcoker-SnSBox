"""Only synthetic local files; no NAS, account, key material or source SQL opens."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("snapshot_prepare", Path(__file__).with_name("prepare.py"))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class PreparationChecks(unittest.TestCase):
    def args(self, root, source, output, *extra):
        return tool.parser().parse_args(["prepare", str(source), "--active-root", str(root / "active"), "--output", str(output), *extra])

    def fixture(self, root):
        profile = root / "snapshot" / "config" / "synthetic-account"
        message = None
        for name in ("session/session.db", "contact/contact.db", "message/message_0.db"):
            path = profile / "db_storage" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(path)
            connection.execute("CREATE TABLE fixture(value TEXT)")
            connection.commit()
            if name.startswith("message/"):
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA wal_autocheckpoint=0")
                connection.execute("INSERT INTO fixture VALUES ('synthetic committed WAL row')")
                connection.commit()
                message = connection
            else:
                connection.close()
        # A login/credential-looking file outside db_storage must never be copied.
        (profile / "key_info.db").write_bytes(b"synthetic non-history material")
        return profile, message

    def test_plaintext_wal_backup_and_readonly_mount_configuration(self):
        with tempfile.TemporaryDirectory(prefix="snsbox-prepare-synthetic-") as temp:
            root = Path(temp).resolve()
            profile, writer = self.fixture(root)
            try:
                before = {path.relative_to(profile): path.read_bytes() for path in profile.rglob("*") if path.is_file()}
                original_sql = tool.sqlite3.connect
                # SQLite must open only newly copied private files, never the input.
                def private_sql(path, *args, **kwargs):
                    self.assertFalse(tool.overlaps(Path(path), profile))
                    return original_sql(path, *args, **kwargs)
                output = root / "prepared"
                args = self.args(root, profile.parent.parent, output,
                                 "--source-kind", "synthetic-fixture", "--snapshot-reference", "synthetic-local-wal",
                                 "--captured-at", "2026-11-15T12:00:00+08:00", "--confirm-consistent-source",
                                 "--allow-plaintext", "--normalize-plaintext")
                original_read = tool.read_only
                def no_shm_read(path):
                    self.assertFalse(str(path).endswith("-shm"))
                    return original_read(path)
                with patch.object(tool.sqlite3, "connect", side_effect=private_sql), patch.object(tool, "read_only", side_effect=no_shm_read):
                    report = tool.prepare(args)
                self.assertTrue(report["readyForReader"])
                self.assertTrue(report["plaintextNormalized"])
                self.assertFalse(report["shmReadOrCopied"])
                self.assertFalse(report["sourceSQLiteOpened"])
                copied = output / "profiles" / profile.name
                self.assertFalse((copied / "key_info.db").exists())
                self.assertFalse(list(copied.rglob("*-wal")))
                with sqlite3.connect(copied / "db_storage/message/message_0.db") as dest:
                    self.assertEqual(dest.execute("SELECT value FROM fixture").fetchall(), [("synthetic committed WAL row",)])
                dest.close()
                self.assertEqual(before, {path.relative_to(profile): path.read_bytes() for path in profile.rglob("*") if path.is_file()})
                entry = json.loads((output / "history-sources.json").read_text(encoding="utf-8"))[0]
                self.assertTrue(entry["confirmedConsistentSnapshot"])
                self.assertEqual(entry["profilePath"], "/history-snapshots/synthetic-account")
                self.assertEqual(entry["capturedAt"], "2026-11-15T04:00:00Z")
                compose = json.loads((output / "compose.history.yaml").read_text(encoding="utf-8"))
                mounts = compose["services"]["snsbox"]["volumes"]
                self.assertTrue(all(item["read_only"] and not item["bind"]["create_host_path"] for item in mounts if item["type"] == "bind"))
                self.assertFalse((output / "INCOMPLETE.json").exists())
                with self.assertRaisesRegex(tool.PreparationError, "Output already exists"):
                    tool.prepare(args)

                mounted = root / "mounted"
                report = tool.prepare(self.args(root, profile, mounted, "--mode", "mount", "--allow-plaintext"))
                self.assertFalse(report["readyForReader"])
                self.assertIn("consistency_unconfirmed", report["blockers"])
                self.assertFalse(json.loads((mounted / "history-sources.json").read_text(encoding="utf-8"))[0]["confirmedConsistentSnapshot"])
                self.assertFalse((mounted / "profiles").exists())
            finally:
                writer.close()

    def test_encrypted_opaque_copy_and_fail_closed_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="snsbox-prepare-synthetic-") as temp:
            root = Path(temp).resolve()
            profile, writer = self.fixture(root)
            writer.close()
            for path in (profile / "db_storage").rglob("*.db"):
                path.write_bytes(b"synthetic-ciphertext-header" + bytes(4096))
            output = root / "opaque"
            original_read = tool.read_only
            def no_shm_read(path):
                self.assertFalse(str(path).endswith("-shm"))
                return original_read(path)
            with patch.object(tool, "read_only", side_effect=no_shm_read):
                report = tool.prepare(self.args(root, profile, output))
            self.assertEqual(report["encryptedOrUnknownCount"], 3)
            self.assertEqual(report["blockers"], ["consistency_unconfirmed", "keys_required"])
            self.assertFalse(json.loads((output / "history-sources.json").read_text(encoding="utf-8"))[0]["confirmedConsistentSnapshot"])
            for path in (profile / "db_storage").rglob("*.db"):
                self.assertEqual(path.read_bytes(), (output / "profiles" / profile.name / path.relative_to(profile)).read_bytes())

            active_args = self.args(root, root / "active" / "nested", root / "should-not-exist")
            with self.assertRaises(tool.PreparationError) as caught, patch.object(tool, "inventory") as inventory:
                tool.prepare(active_args)
            self.assertEqual(caught.exception.code, "active_overlap")
            inventory.assert_not_called()
            self.assertFalse((root / "should-not-exist").exists())

            with self.assertRaises(tool.PreparationError) as caught:
                tool.prepare(self.args(root, profile, profile / "output"))
            self.assertEqual(caught.exception.code, "data_overlap")

            with self.assertRaises(tool.PreparationError) as caught:
                tool.prepare(self.args(root, profile, root / "false-confirmation", "--confirm-consistent-source", "--captured-at", "2026-11-15T00:00:00Z", "--snapshot-reference", "metadata-only"))
            self.assertEqual(caught.exception.code, "provenance_required")

            changed = root / "changed"
            original_copy = tool.copy_file
            def copy_then_change(source, target, expected):
                original_copy(source, target, expected)
                if source.name == "session.db":
                    # This is our disposable synthetic producer, never an active profile.
                    source.write_bytes(source.read_bytes() + b"changed")
            with patch.object(tool, "copy_file", side_effect=copy_then_change), self.assertRaises(tool.PreparationError) as caught:
                tool.prepare(self.args(root, profile, changed))
            self.assertEqual(caught.exception.code, "source_changed")
            self.assertTrue((changed / "INCOMPLETE.json").exists())
            self.assertFalse((changed / "history-sources.json").exists())

            journal = profile / "db_storage/message/message_0.db-journal"
            journal.write_bytes(b"synthetic journal")
            with self.assertRaises(tool.PreparationError) as caught:
                tool.prepare(self.args(root, profile, root / "journal-rejected"))
            self.assertEqual(caught.exception.code, "rollback_journal")
            journal.unlink()

            renamed = profile.with_name("synthetic-${SNSBOX_UNSET_TEST}-资料")
            profile.rename(renamed)
            special = root / "special-output"
            tool.prepare(self.args(root, renamed, special, "--mode", "mount"))
            special_entry = json.loads((special / "history-sources.json").read_text(encoding="utf-8"))[0]
            self.assertTrue(special_entry["profilePath"].endswith(renamed.name))
            mounts = json.loads((special / "compose.history.yaml").read_text(encoding="utf-8"))["services"]["snsbox"]["volumes"]
            profile_mount = next(item for item in mounts if item.get("target", "").startswith("/history-snapshots/"))
            self.assertTrue(profile_mount["source"].endswith(renamed.name.replace("$", "$$")))
            self.assertTrue(profile_mount["target"].endswith(renamed.name.replace("$", "$$")))


if __name__ == "__main__":
    unittest.main()
