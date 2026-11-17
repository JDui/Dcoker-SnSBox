"""Focused Docker permission/boundary checks with synthetic inputs only."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import prepare

spec = importlib.util.spec_from_file_location("stage_compose", Path(__file__).with_name("stage-compose.py"))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class StageChecks(unittest.TestCase):
    def bundle(self, root):
        profile = root / "snapshot" / "synthetic-account"
        for name in ("session/session.db", "contact/contact.db", "message/message_0.db"):
            path = profile / "db_storage" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic-opaque-copy" + bytes(4096))
        keys = root / "synthetic-key.json"
        keys.write_bytes(b'{"fixture":"not-a-real-key"}')
        keys.chmod(0o666)
        bundle = root / "bundle"
        prepare.prepare(prepare.parser().parse_args(["prepare", str(profile), "--active-root", str(root / "active"),
                        "--keys-file", str(keys), "--source-kind", "synthetic-fixture", "--confirm-consistent-source",
                        "--snapshot-reference", "synthetic-permissions", "--captured-at", "2026-11-17T00:00:00Z", "--output", str(bundle)]))
        return bundle, keys

    def args(self, root, bundle, name):
        return argparse.Namespace(bundle=str(bundle), output=str(root / name), active_root=[str(root / "active")], image="snsbox:0.1.0")

    def test_volume_permissions_and_failure_boundaries(self):
        for endpoint in ("tcp://remote.invalid:2375", "ssh://remote.invalid", "unix://remote.invalid/socket", "npipe:////remote.invalid/pipe/docker_engine"):
            with patch.dict(os.environ, {"DOCKER_HOST": endpoint, "DOCKER_CONTEXT": ""}), patch.object(tool, "docker") as docker, self.assertRaises(tool.StageError):
                tool.require_local_engine("snsbox:0.1.0")
            docker.assert_not_called()
        with tempfile.TemporaryDirectory(prefix="snsbox-stage-synthetic-") as temporary:
            root = Path(temporary).resolve()
            bundle, keys = self.bundle(root)
            key_before = (keys.read_bytes(), stat.S_IMODE(keys.stat().st_mode))
            args = self.args(root, bundle, "deployment")
            report = tool.stage(args)  # Includes a real UID 10001 read/write/600 check.
            token = report["inputVolume"].removeprefix("snsbox-history-").removesuffix("-input")
            try:
                self.assertTrue(report["permissionCheckPassed"])
                self.assertTrue(report["sourceConsistencyPreserved"])
                self.assertTrue(report["confirmedConsistentSnapshot"])
                self.assertEqual((keys.read_bytes(), stat.S_IMODE(keys.stat().st_mode)), key_before)
                deployment = json.loads((root / "deployment/compose.history.yaml").read_text(encoding="utf-8"))
                self.assertEqual(deployment["services"]["snsbox"]["user"], "10001:10001")
                self.assertTrue(deployment["services"]["snsbox"]["volumes"][0]["read_only"])
                self.assertNotIn("bind", json.dumps(deployment))
                for value in deployment["volumes"].values():
                    self.assertTrue(value["external"])
                self.assertFalse((root / "deployment/INCOMPLETE.json").exists())
                with self.assertRaises(prepare.PreparationError) as caught, patch.object(tool, "docker") as docker:
                    tool.stage(args)
                self.assertEqual(caught.exception.code, "output_exists")
                docker.assert_not_called()
            finally:
                tool.remove_owned_volumes([report["inputVolume"], report["scratchVolume"]], token)

            link = root / "bundle-link"
            if os.name == "nt":
                script = root / "create-junction.ps1"
                script.write_text('param($LinkPath,$TargetPath)\nNew-Item -ItemType Junction -Path $LinkPath -Value $TargetPath | Out-Null\n', encoding="utf-8")
                subprocess.run(["powershell", "-NoProfile", "-File", str(script), str(link), str(bundle)], check=True, capture_output=True)
            else:
                link.symlink_to(bundle, target_is_directory=True)
            with self.assertRaises(prepare.PreparationError) as caught, patch.object(tool, "docker") as docker:
                tool.stage(self.args(root, link, "linked-deployment"))
            self.assertEqual(caught.exception.code, "unsafe_path")
            docker.assert_not_called()

            failed = self.args(root, bundle, "interrupted")
            with patch.object(tool, "archive_file", side_effect=prepare.PreparationError("source_changed")), self.assertRaises(prepare.PreparationError):
                tool.stage(failed)
            self.assertTrue((root / "interrupted/INCOMPLETE.json").exists())
            self.assertFalse((root / "interrupted/compose.history.yaml").exists())
            self.assertEqual((keys.read_bytes(), stat.S_IMODE(keys.stat().st_mode)), key_before)


if __name__ == "__main__":
    unittest.main()
