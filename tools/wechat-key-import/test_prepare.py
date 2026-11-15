"""Focused synthetic checks. Needs the fixture binary; never opens a real profile/PID."""
import argparse
import contextlib
import ctypes
import errno
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import prepare
from vendor import linux_memory

FIXTURE = None


class PreparationChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='snsbox-key-test-')
        cls.base = Path(cls.temporary.name)
        cls.root = cls.base / 'fixture'
        result = subprocess.run([FIXTURE, 'create', str(cls.root)], capture_output=True)
        if result.returncode:
            raise RuntimeError('synthetic fixture creation failed')
        cls.active = cls.base / 'unused-active-boundary'
        cls.active.mkdir(mode=0o700)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def arguments(self, mode='raw', output='result.json'):
        return prepare.parser().parse_args([
            'import-cache', '--snapshot', str(self.root / ('synthetic-' + mode)),
            '--confirmed-snapshot', '--output', str(self.root / output),
            '--key-file', str(self.root / (mode + '.key')),
        ])

    def test_01_password_and_raw_consumed_by_real_reader(self):
        for mode in ('password', 'raw'):
            args = self.arguments(mode, mode + '.json')
            result = prepare.prepare(args)
            self.assertTrue(result['ok'])
            data = json.loads(Path(args.output).read_text())
            self.assertGreaterEqual(len(data['databases']), 3)
            self.assertEqual(Path(args.output).stat().st_mode & 0o777, 0o600)
            # Different database salts must produce different page keys in password mode.
            if mode == 'password':
                self.assertGreater(len({db['rawPageKeyBase64'] for db in data['databases']}), 1)
            check = subprocess.run([FIXTURE, 'verify', args.snapshot, args.output], capture_output=True)
            self.assertEqual(check.returncode, 0, 'real SQLCipher/ProfileReader verification failed')

    def test_02_wrong_key_and_insecure_cache_fail_without_output(self):
        args = self.arguments(output='rejected.json')
        args.key_file = [str(self.root / 'password.key')]
        with self.assertRaisesRegex(prepare.Refused, 'key_mismatch'):
            prepare.prepare(args)
        self.assertFalse(Path(args.output).exists())
        cache = self.root / 'insecure.key'
        cache.write_text('42' * 32)
        cache.chmod(0o644)
        args.key_file = [str(cache)]
        with self.assertRaisesRegex(prepare.Refused, 'private_key_file_required'):
            prepare.prepare(args)
        self.assertFalse(Path(args.output).exists())

    def test_03_source_and_output_boundaries(self):
        args = self.arguments(output='already-exists.json')
        Path(args.output).write_text('preserve')
        with self.assertRaisesRegex(prepare.Refused, 'output_exists'):
            prepare.prepare(args)
        self.assertEqual(Path(args.output).read_text(), 'preserve')
        args.output = str(Path(args.snapshot) / 'bad.json')
        with self.assertRaisesRegex(prepare.Refused, 'output_overlaps_source'):
            prepare.prepare(args)
        link = self.root / 'linked-profile'
        link.symlink_to(Path(args.snapshot), target_is_directory=True)
        args.snapshot, args.output = str(link), str(self.root / 'linked.json')
        with self.assertRaises(OSError):
            prepare.prepare(args)

    def test_04_memory_permission_denial_has_no_fallback(self):
        class DeniedCall:
            def __call__(self, *args):
                ctypes.set_errno(errno.EPERM)
                return -1
        class DeniedLibc:
            process_vm_readv = DeniedCall()
        with patch.object(linux_memory.ctypes, 'CDLL', return_value=DeniedLibc()):
            with self.assertRaises(linux_memory.ProcessMemoryAccessDenied):
                linux_memory.read_process_memory(os.getpid(), 0, 32)
        # Also require a path-free/secret-free CLI error when that denial reaches the boundary.
        args = ['prepare.py', 'scan', '--pid', '1', '--expected-exe', '/synthetic',
                '--snapshot', '/synthetic', '--output', '/secret-name.json']
        with patch.object(sys, 'argv', args), patch.object(prepare, 'prepare',
                side_effect=linux_memory.ProcessMemoryAccessDenied()), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(prepare.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'code': 'process_access_denied'})

    def test_05_only_synthetic_child_passive_scan(self):
        # No client discovery or real client process. The synthetic child exits on stdin EOF.
        source = "import ctypes,sys; blob=ctypes.create_string_buffer(b\"x'\"+b'42'*32+b\"'\"); print('ready',flush=True); sys.stdin.read()"
        child = subprocess.Popen([sys.executable, '-c', source], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            args = prepare.parser().parse_args([
                'scan', '--pid', str(child.pid), '--expected-exe', str(Path(sys.executable).resolve()),
                '--snapshot', str(self.root / 'synthetic-raw'), '--confirmed-snapshot',
                '--active-root', str(self.active), '--output', str(self.root / 'scanned.json'),
                '--timeout', '30',
            ])
            self.assertTrue(prepare.prepare(args)['ok'])
            status = Path('/proc', str(child.pid), 'status').read_text()
            self.assertIn('TracerPid:\t0', status)
            self.assertNotIn('State:\tT', status)
        finally:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('--fixture-tool', required=True)
    opts, rest = cli.parse_known_args()
    FIXTURE = str(Path(opts.fixture_tool).resolve(strict=True))
    unittest.main(argv=[sys.argv[0], *rest])
