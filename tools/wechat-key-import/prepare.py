#!/usr/bin/env python3
"""Offline KeyFile preparation; Linux-only filesystem policy, no network/client control."""
from __future__ import annotations

import argparse
import base64
import errno
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

from vendor.linux_memory import ProcessMemoryAccessDenied, iter_process_memory_chunks
from vendor.sqlcipher_keys import _effective_page_key

MAX_DATABASES = 256
MAX_ENTRIES = 10000
MAX_CANDIDATES = 128
MAX_SCAN_BYTES = 512 * 1024 * 1024
PATTERNS = (re.compile(rb"x'([0-9a-fA-F]{64,192})'"),
            re.compile(rb"(?<![0-9a-fA-F])([0-9a-fA-F]{64})(?=\x00)"))


class Refused(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def absolute(value: str | Path) -> Path:
    path = Path(value)
    if '..' in path.parts:
        raise Refused('unsafe_path')
    return Path(os.path.abspath(path))


def overlaps(a: Path, b: Path) -> bool:
    return a == b or a in b.parents or b in a.parents


def directory(path: Path) -> int:
    """Open every path component without following symlinks, then retain the fd."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in absolute(path).parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                              os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def private_directory(fd: int) -> None:
    meta = os.fstat(fd)
    if meta.st_uid != os.geteuid() or stat.S_IMODE(meta.st_mode) != 0o700:
        raise Refused('private_directory_required')


def file_read(fd: int, name: str, limit: int, secret: bool = False) -> bytes:
    opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC |
                     os.O_NONBLOCK, dir_fd=fd)
    try:
        meta = os.fstat(opened)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1:
            raise Refused('unsafe_file')
        if secret and (meta.st_uid != os.geteuid() or stat.S_IMODE(meta.st_mode) != 0o600):
            raise Refused('private_key_file_required')
        if secret and meta.st_size > limit:
            raise Refused('invalid_key_cache')
        data = os.read(opened, limit)
        after = os.fstat(opened)
        if (meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise Refused('source_changed')
        return data
    finally:
        os.close(opened)


def cache_key(path: Path) -> bytes:
    parent = directory(path.parent)
    try:
        private_directory(parent)
        text = file_read(parent, path.name, 1024, secret=True).strip()
    finally:
        os.close(parent)
    if not re.fullmatch(rb'[0-9a-fA-F]{64}', text):
        raise Refused('invalid_key_cache')
    return bytes.fromhex(text.decode('ascii'))


def headers(profile_fd: int) -> dict[str, bytes]:
    """Read only 4096-byte DB headers, never open SQLite or inspect WAL contents."""
    result: dict[str, bytes] = {}
    count = 0

    def walk(fd: int, prefix: str, depth: int) -> None:
        nonlocal count
        if depth > 16:
            raise Refused('source_limit_exceeded')
        # Bound enumeration before sorting; avoid materializing arbitrary huge directories.
        names = []
        with os.scandir(fd) as entries:
            for entry in entries:
                count += 1
                if count > MAX_ENTRIES:
                    raise Refused('source_limit_exceeded')
                names.append(entry.name)
        for name in sorted(names):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise Refused('unsafe_file')
            relative = prefix + name
            if '\\' in relative or '\x00' in relative or len(relative) > 4096:
                raise Refused('unsafe_path')
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                                os.O_CLOEXEC, dir_fd=fd)
                try:
                    walk(child, relative + '/', depth + 1)
                finally:
                    os.close(child)
            elif name.endswith('.db'):
                if len(result) >= MAX_DATABASES:
                    raise Refused('source_limit_exceeded')
                page = file_read(fd, name, 4096)
                if len(page) != 4096 or page.startswith(b'SQLite format 3\x00'):
                    raise Refused('encrypted_sqlcipher4_required')
                result[relative] = page

    storage = os.open('db_storage', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                      os.O_CLOEXEC, dir_fd=profile_fd)
    try:
        walk(storage, '', 0)
    finally:
        os.close(storage)
    if not result:
        raise Refused('database_unavailable')
    return result


def process_identity(pid: int, expected_exe: Path) -> tuple:
    """No autodiscovery, signals or debugger attachment; check PID reuse and executable."""
    try:
        proc = Path('/proc') / str(pid)
        exe = (proc / 'exe').resolve(strict=True)
        if exe != expected_exe:
            raise Refused('process_identity_mismatch')
        # The comm field can contain spaces and parentheses; starttime is field 22.
        raw = (proc / 'stat').read_text()
        start_time = raw[raw.rfind(')') + 2:].split()[19]
        info = (proc / 'exe').stat()
        return start_time, info.st_dev, info.st_ino, exe
    except PermissionError:
        raise Refused('process_access_denied') from None
    except (FileNotFoundError, ProcessLookupError):
        raise Refused('process_unavailable') from None


def memory_candidates(pid: int, deadline: float):
    seen: set[bytes] = set()
    scanned = 0
    # Use only the audited process_vm_readv module, never the upstream C helper/CLI.
    for chunk in iter_process_memory_chunks(pid, timeout_s=max(0.01, deadline-time.monotonic())):
        if time.monotonic() >= deadline:
            raise Refused('scan_timeout')
        scanned += len(chunk)
        if scanned > MAX_SCAN_BYTES:
            raise Refused('scan_limit_exceeded')
        for pattern in PATTERNS:
            for match in pattern.finditer(chunk):
                key = bytes.fromhex(match.group(1)[:64].decode('ascii'))
                if key in seen:
                    continue
                seen.add(key)
                if len(seen) > MAX_CANDIDATES:
                    raise Refused('candidate_limit_exceeded')
                yield key
    if time.monotonic() >= deadline:
        raise Refused('scan_timeout')


def prepare(args) -> dict:
    if not sys.platform.startswith('linux'):
        raise Refused('linux_host_required')
    # No raw memory or keys in core dumps. Python cannot promise secret zeroization.
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if not args.confirmed_snapshot:
        raise Refused('snapshot_confirmation_required')
    profile = absolute(args.snapshot)
    output = absolute(args.output)
    if not profile.name or profile.name == 'db_storage' or len(profile.name) > 512:
        raise Refused('account_root_required')
    if output == profile or profile in output.parents:
        raise Refused('output_overlaps_source')
    if args.active_root:
        active = absolute(args.active_root).resolve(strict=True)
        if overlaps(profile, active) or output == active or active in output.parents:
            raise Refused('active_source_overlap')
    elif args.command == 'scan':
        raise Refused('active_source_boundary_required')
    root_fd = directory(profile)
    out_fd = None
    try:
        out_fd = directory(output.parent)
        private_directory(out_fd)
        if output.name in os.listdir(out_fd):
            raise Refused('output_exists')
        pages = headers(root_fd)
        deadline = time.monotonic() + args.timeout
        identity = None
        if args.command == 'scan':
            expected = absolute(args.expected_exe).resolve(strict=True)
            identity = process_identity(args.pid, expected)
            candidates = memory_candidates(args.pid, deadline)
        else:
            if len(args.key_file) > 16:
                raise Refused('candidate_limit_exceeded')
            candidates = (cache_key(absolute(path)) for path in args.key_file)
        matched: dict[str, bytes] = {}
        for key in candidates:
            for relative, page in pages.items():
                if time.monotonic() >= deadline:
                    raise Refused('scan_timeout' if args.command == 'scan' else 'conversion_timeout')
                if relative in matched:
                    continue
                effective = _effective_page_key(key, page)
                if effective is not None:
                    matched[relative] = effective
            if len(matched) == len(pages):
                break
        if not matched:
            raise Refused('no_matching_key_or_unsupported_layout' if args.command == 'scan' else 'key_mismatch')
        if len(matched) != len(pages):
            raise Refused('incomplete_key_coverage')
        if identity is not None and identity != process_identity(args.pid, expected):
            raise Refused('process_changed')
        if headers(root_fd) != pages:
            raise Refused('source_changed')
        document = {
            'schemaVersion': 1, 'format': 'official-linux', 'accountBinding': profile.name,
            'sqlcipher': {'compatibility': 4, 'pageSize': 4096, 'kdfIterations': 256000},
            'databases': [
                {'relativePath': relative, 'saltHex': pages[relative][:16].hex(),
                 'rawPageKeyBase64': base64.b64encode(matched[relative]).decode('ascii')}
                for relative in sorted(pages)
            ],
            'imageDat': None,
        }
        payload = (json.dumps(document, separators=(',', ':')) + '\n').encode('utf-8')
        # New file only: do not chmod, truncate, replace or delete any existing file.
        fd = os.open(output.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                     os.O_CLOEXEC, 0o600, dir_fd=out_fd)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            os.unlink(output.name, dir_fd=out_fd)
            raise
        return {'ok': True, 'code': 'keyfile_prepared', 'databaseCount': len(matched),
                'validation': 'sqlcipher4-page1-hmac-only', 'historyVerified': False,
                'clientVersionVerified': False, 'sourceConsistency': 'operator-confirmed-copy'}
    finally:
        os.close(root_fd)
        if out_fd is not None:
            os.close(out_fd)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest='command', required=True)
    for name in ('import-cache', 'scan'):
        command = commands.add_parser(name)
        command.add_argument('--snapshot', required=True, help='Independent account root with db_storage')
        command.add_argument('--confirmed-snapshot', action='store_true')
        command.add_argument('--active-root', help='Known live profile root, excluded from source/output')
        command.add_argument('--output', required=True, help='New file in an existing owned 0700 directory')
        command.add_argument('--timeout', type=int, default=120, choices=range(1, 121), metavar='1..120')
        if name == 'scan':
            command.add_argument('--pid', type=int, required=True)
            command.add_argument('--expected-exe', required=True)
        else:
            command.add_argument('--key-file', action='append', required=True,
                                 help='Explicit owned 0600 chatlog-keeper 64-hex cache; repeat for multiple keys')
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == 'scan' and args.pid <= 0:
            raise Refused('invalid_pid')
        value = prepare(args)
    except ProcessMemoryAccessDenied:
        value = {'ok': False, 'code': 'process_access_denied'}
    except Refused as error:
        value = {'ok': False, 'code': error.code}
    except OSError as error:
        code = {errno.EACCES: 'permission_denied', errno.EPERM: 'permission_denied',
                errno.ELOOP: 'unsafe_path', errno.ENOTDIR: 'unsafe_path',
                errno.EEXIST: 'output_exists', errno.ENOENT: 'input_unavailable'}.get(error.errno, 'io_failed')
        value = {'ok': False, 'code': code}
    except KeyboardInterrupt:
        value = {'ok': False, 'code': 'cancelled'}
    except Exception:
        value = {'ok': False, 'code': 'preparation_failed'}
    print(json.dumps(value, separators=(',', ':')))
    return 0 if value['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
