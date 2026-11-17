import argparse
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import convert
import fixture


class ConversionTests(unittest.TestCase):
    def args(self, root, source, name="converted", **updates):
        values = dict(database=str(source), account_id="10001", output_dir=str(root / name),
            active_root=[str(root / "protected")], confirmed_independent_copy=True,
            source_id="qq-fixture", container_path="/fixtures/converted/qq_messages.json")
        values.update(updates)
        return argparse.Namespace(**values)

    def test_actual_sqlite_parser_to_json_preserves_full_text_and_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            expected = fixture.create(root / "fixtures")
            source = root / "fixtures/account-a/nt_msg.db"
            original = source.read_bytes()
            original_names = sorted(p.name for p in source.parent.iterdir())
            report = convert.convert(self.args(root, source))
            records = json.loads((root / "converted/qq_messages.json").read_text(encoding="utf-8"))
            self.assertEqual(report["messages"], expected["accounts"]["account-a"]["messages"])
            self.assertEqual(report["unreadable"], 2)
            self.assertEqual(records[0]["content"], fixture.LONG_TEXT)
            self.assertTrue(records[0]["content"].endswith(fixture.LONG_TAIL))
            self.assertEqual(records[1]["ts"], records[2]["ts"])
            self.assertNotEqual(records[1]["source_offset"], records[2]["source_offset"])
            self.assertEqual(records[0]["msg_id"], "9007199254740993")
            self.assertNotIn("private-token", json.dumps(records))
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(sorted(p.name for p in source.parent.iterdir()), original_names)
            source_b = root / "fixtures/account-b/nt_msg.db"
            convert.convert(self.args(root, source_b, "converted-b", account_id="20001"))
            records_b = json.loads((root / "converted-b/qq_messages.json").read_text(encoding="utf-8"))
            self.assertEqual(len(records_b), 2)
            self.assertNotEqual(records[0]["account_id"], records_b[0]["account_id"])

    def test_reject_boundaries_and_retain_overlimit_placeholder(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture.create(root / "fixtures")
            source = root / "fixtures/account-a/nt_msg.db"
            for updates in (dict(confirmed_independent_copy=False), dict(active_root=[str(source.parent)])):
                with self.assertRaises(convert.Refused):
                    convert.convert(self.args(root, source, **updates))
                self.assertFalse((root / "converted").exists())
            wal = Path(str(source) + "-wal")
            wal.write_bytes(b"synthetic WAL prevents import")
            with self.assertRaises(convert.Refused):
                convert.convert(self.args(root, source))
            wal.unlink()
            # Mutation is only to the newly generated synthetic database.
            connection = sqlite3.connect(source)
            try:
                connection.execute('UPDATE c2c_msg_table SET "40800"=? WHERE rowid=1', (fixture.text_body("长" * 23000),))
                connection.commit()
            finally:
                connection.close()
            report = convert.convert(self.args(root, source))
            self.assertEqual(report["unreadableReasons"]["text_limit"], 1)
            records = json.loads((root / "converted/qq_messages.json").read_text(encoding="utf-8"))
            self.assertEqual(records[0]["content"], "")
            self.assertEqual(records[0]["decode_status"], "unreadable")
            with self.assertRaises(convert.Refused):
                convert.convert(self.args(root, source))
            wrong = root / "fixtures/account-b/not-decrypted.db"
            wrong.write_bytes(b"encrypted synthetic database")
            with self.assertRaisesRegex(convert.Refused, "not_decrypted_sqlite"):
                convert.convert(self.args(root, wrong, "bad"))
            self.assertFalse((root / "bad").exists())


if __name__ == "__main__":
    unittest.main()
