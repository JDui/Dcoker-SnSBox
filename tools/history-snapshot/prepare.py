#!/usr/bin/env python3
"""Prepare an independent history input; never connect SQLite to the input.

Python 3.10+, standard library only. Generated material belongs in private/.
Consistency is supplied by the snapshot/export producer, never inferred from
matching metadata. SQLite backup runs only on a newly copied plaintext DB.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
from datetime import datetime, timezone

REPO = next((parent for parent in Path(__file__).resolve().parents
             if (parent / "Cargo.toml").is_file() and (parent / "AGENTS.md").is_file()), None)
MAX_FILE = 2 * 1024**3
MAX_TOTAL = 8 * 1024**3
MAX_DATABASES = 256
MAX_ENTRIES = 20_000
SQLITE_HEADER = b"SQLite format 3\0"
MESSAGES = {
    "active_overlap": "Input/output overlaps a protected active profile root; nothing was prepared.",
    "data_overlap": "Input overlaps SnSBox data, or output overlaps the input; choose separate directories.",
    "unsafe_path": "Symlinks, junctions, special files and path replacements are not accepted.",
    "source_missing": "Input is unavailable. Supply an independent snapshot/export, not the active client.",
    "profile_selection": "Select one account root containing db_storage; zero or multiple profiles were found.",
    "layout_incomplete": "Session, contact and message database families must all be present.",
    "limit": "Input exceeds the bounded file, database or byte limit.",
    "source_changed": "Input changed during preparation; no import configuration was published.",
    "rollback_journal": "A nonempty rollback journal requires a compatible exporter; this reader input is not prepared.",
    "provenance_required": "Confirm only a real NAS snapshot/offline export, with its reference and capture time.",
    "output_exists": "Output already exists; use a new directory. Existing files were not overwritten.",
    "output_private": "Repository output must be below private/ so personal material is ignored by Git.",
    "plaintext_required": "Plaintext normalization requires explicit --allow-plaintext and exclusively SQLite-header databases.",
    "plaintext_invalid": "The private plaintext copy could not be recovered/backed up; no import configuration was published.",
    "key_file": "The optional key file must be an existing regular file outside active/source/output directories.",
    "io": "Preparation could not finish. Check access and free space; input was not modified.",
}


class PreparationError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(MESSAGES[code])


def fail(code: str):
    raise PreparationError(code)


def overlaps(a: Path, b: Path) -> bool:
    return a == b or a in b.parents or b in a.parents


def absolute(value: str | Path) -> Path:
    return Path(os.path.abspath(os.path.expanduser(str(value))))


def reject_links(path: Path):
    for item in reversed((path, *path.parents)):
        try:
            value = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400:
            fail("unsafe_path")


def fingerprint(path: Path) -> tuple[int, int, int, int]:
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400:
        fail("unsafe_path")
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


def read_only(path: Path):
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    return os.fdopen(os.open(path, flags), "rb")


def select_profile(source: Path) -> Path:
    if source.name == "db_storage":
        source = source.parent
    found: list[Path] = []
    count = 0

    def visit(directory: Path, depth: int):
        nonlocal count
        if depth > 10:
            fail("limit")
        reject_links(directory)
        storage = directory / "db_storage"
        if storage.is_dir():
            reject_links(storage)
            found.append(directory)
            if len(found) > 1:
                fail("profile_selection")
            return
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > MAX_ENTRIES:
                    fail("limit")
                if entry.is_symlink() or getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400:
                    fail("unsafe_path")
                if entry.is_dir(follow_symlinks=False):
                    visit(Path(entry.path), depth + 1)

    visit(source, 0)
    if len(found) != 1:
        fail("profile_selection")
    return found[0]


def inventory(profile: Path) -> dict[str, tuple[int, int, int, int]]:
    root = profile / "db_storage"
    files: dict[str, tuple[int, int, int, int]] = {}
    entries_seen = 0

    def visit(directory: Path, depth: int):
        nonlocal entries_seen
        if depth > 10:
            fail("limit")
        with os.scandir(directory) as entries:
            for entry in entries:
                entries_seen += 1
                if entries_seen > MAX_ENTRIES:
                    fail("limit")
                value = entry.stat(follow_symlinks=False)
                if entry.is_symlink() or getattr(value, "st_file_attributes", 0) & 0x400:
                    fail("unsafe_path")
                path = Path(entry.path)
                if stat.S_ISDIR(value.st_mode):
                    visit(path, depth + 1)
                elif not stat.S_ISREG(value.st_mode):
                    fail("unsafe_path")
                elif re.search(r"\.db(?:-wal|-shm|-journal)?$", entry.name):
                    files[path.relative_to(profile).as_posix()] = fingerprint(path)

    visit(root, 0)
    databases = [name for name in files if name.endswith(".db")]
    if len(databases) > MAX_DATABASES or any(value[2] > MAX_FILE for value in files.values()) or sum(value[2] for value in files.values()) > MAX_TOTAL:
        fail("limit")
    if not {"db_storage/session/session.db", "db_storage/contact/contact.db"}.issubset(files) or not any(re.fullmatch(r"db_storage/message/message_\d+\.db", name) for name in databases):
        fail("layout_incomplete")
    if any(name.endswith("-journal") and value[2] for name, value in files.items()):
        fail("rollback_journal")
    return files


def formats(profile: Path, files: dict) -> dict[str, str]:
    result = {}
    for name, expected in files.items():
        if not name.endswith(".db"):
            continue
        with read_only(profile / name) as handle:
            value = os.fstat(handle.fileno())
            if (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns) != expected:
                fail("source_changed")
            result[name] = "plaintext" if handle.read(16) == SQLITE_HEADER else "encrypted_or_unknown"
    return result


def capture_time(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            fail("provenance_required")
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        fail("provenance_required")


def copy_file(source: Path, target: Path, expected: tuple):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with read_only(source) as src:
        value = os.fstat(src.fileno())
        if (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns) != expected:
            fail("source_changed")
        with target.open("xb") as dst:
            if os.name != "nt":
                os.fchmod(dst.fileno(), 0o600)
            remaining = expected[2]
            while remaining:
                block = src.read(min(1024 * 1024, remaining))
                if not block:
                    fail("source_changed")
                dst.write(block)
                remaining -= len(block)
            if src.read(1):
                fail("source_changed")


def normalize_plaintext(profile: Path, names: list[str]):
    """Only this newly created private copy receives SQLite locks/recovery."""
    for name in names:
        path = profile / name
        temporary = path.with_name(path.name + ".backup")
        try:
            deadline = time.monotonic() + 60
            def progress(_status, _remaining, _total):
                if time.monotonic() > deadline:
                    fail("plaintext_invalid")
            with temporary.open("xb") as new_file:
                if os.name != "nt":
                    os.fchmod(new_file.fileno(), 0o600)
            with closing(sqlite3.connect(str(path), timeout=1)) as source, closing(sqlite3.connect(str(temporary), timeout=1)) as dest:
                source.execute("PRAGMA query_only=ON")
                source.backup(dest, pages=256, progress=progress, sleep=0.01)
                if dest.execute("PRAGMA quick_check(1)").fetchone() != ("ok",):
                    fail("plaintext_invalid")
            # Close both connections before replacing anything (also on Windows).
            if os.name != "nt":
                temporary.chmod(0o600)
            os.replace(temporary, path)
            for suffix in ("-wal", "-shm"):
                path.with_name(path.name + suffix).unlink(missing_ok=True)
        except (sqlite3.Error, OSError):
            fail("plaintext_invalid")


def write_json(path: Path, value):
    with path.open("x", encoding="utf-8") as handle:
        if os.name != "nt":
            os.fchmod(handle.fileno(), 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def prepare(args) -> dict:
    active = [path for value in args.active_root for path in (absolute(value), absolute(value).resolve())]
    source = absolute(args.source)
    output = absolute(args.output) if args.command == "prepare" else None
    # Reject lexical overlap before inspecting files under an active path.
    if any(overlaps(source, root) or output is not None and overlaps(output, root) for root in active):
        fail("active_overlap")
    reject_links(source)
    if not source.is_dir():
        fail("source_missing")
    source = source.resolve()
    if any(overlaps(source, root) for root in active):
        fail("active_overlap")
    if REPO is not None and overlaps(source, REPO / "data"):
        fail("data_overlap")
    if output is not None:
        reject_links(output)
        output = output.resolve()
        if any(overlaps(output, root) for root in active):
            fail("active_overlap")
        if overlaps(source, output) or REPO is not None and overlaps(output, REPO / "data"):
            fail("data_overlap")
        if REPO is not None and REPO in output.parents and not (REPO / "private") in output.parents:
            fail("output_private")
        if output.exists():
            fail("output_exists")
    captured = capture_time(args.captured_at)
    confirmed = args.confirm_consistent_source
    if confirmed and (args.source_kind == "unverified-copy" or not captured or not args.snapshot_reference):
        fail("provenance_required")
    profile = select_profile(source)
    files = inventory(profile)
    file_formats = formats(profile, files)
    all_plaintext = all(value == "plaintext" for value in file_formats.values())
    if args.normalize_plaintext and (args.command != "prepare" or not args.allow_plaintext or not all_plaintext or args.mode != "copy"):
        fail("plaintext_required")
    keys = None
    if args.keys_file:
        keys = absolute(args.keys_file)
        reject_links(keys)
        keys = keys.resolve()
        if any(overlaps(keys, root) for root in active) or overlaps(keys, source) or output is not None and overlaps(keys, output) or not keys.is_file():
            fail("key_file")
    blockers = []
    if not confirmed:
        blockers.append("consistency_unconfirmed")
    if not all_plaintext and keys is None:
        blockers.append("keys_required")
    if all_plaintext and not args.allow_plaintext:
        blockers.append("plaintext_not_enabled")
    report = {
        "version": 1, "sourceKind": args.source_kind,
        "consistency": {"operatorConfirmed": confirmed, "reference": args.snapshot_reference, "capturedAt": captured, "verifiedByTool": False},
        "databaseCount": len(file_formats),
        "plaintextCount": sum(value == "plaintext" for value in file_formats.values()),
        "encryptedOrUnknownCount": sum(value != "plaintext" for value in file_formats.values()),
        "walCount": sum(name.endswith("-wal") for name in files),
        "shmObserved": sum(name.endswith("-shm") for name in files),
        "shmReadOrCopied": False, "sourceSQLiteOpened": False,
        "metadataStable": False, "plaintextNormalized": False,
        "readyForReader": not blockers, "blockers": blockers,
        "readerValidation": "pending; no decryption or real-history acceptance claimed",
    }
    if output is None:
        if inventory(profile) != files:
            fail("source_changed")
        report["metadataStable"] = True
        return report
    output.mkdir(parents=True, mode=0o700)
    # The marker survives failure; configurations are published only at the end.
    write_json(output / "INCOMPLETE.json", {"complete": False, "message": "Do not import this directory until preparation completes."})
    if args.mode == "copy":
        destination = output / "profiles" / profile.name
        for name, expected in files.items():
            if name.endswith((".db", ".db-wal")):
                copy_file(profile / name, destination / name, expected)
        if args.normalize_plaintext:
            normalize_plaintext(destination, list(file_formats))
            report["plaintextNormalized"] = True
        host_profile = destination
    else:
        host_profile = profile
    if inventory(profile) != files:
        fail("source_changed")
    report["metadataStable"] = True
    profile_target = "/history-snapshots/" + profile.name
    entry = {"id": args.id, "platform": "wechat", "displayName": args.display_name,
             "profilePath": profile_target, "allowPlaintext": args.allow_plaintext,
             "confirmedConsistentSnapshot": confirmed, "capturedAt": captured}
    def bind(host: Path, target: str):
        # Compose interpolates dollar signs even in JSON/YAML quoted strings.
        return {"type": "bind", "source": str(host).replace("$", "$$"), "target": target.replace("$", "$$"), "read_only": True, "bind": {"create_host_path": False}}
    mounts = [bind(output / "history-sources.json", "/run/config/history-sources.json"), bind(host_profile, profile_target),
              {"type": "volume", "source": "snsbox-history-scratch", "target": "/var/cache/snsbox-history"}]
    if keys is not None:
        entry["keysFile"] = "/run/secrets/history-wechat-keys.json"
        mounts.append(bind(keys, entry["keysFile"]))
    compose = {"services": {"snsbox": {"environment": {"SNSBOX_HISTORY_SOURCES_FILE": "/run/config/history-sources.json", "TMPDIR": "/var/cache/snsbox-history"}, "volumes": mounts}},
               "volumes": {"snsbox-history-scratch": {}}}
    write_json(output / "preparation-report.json", report)
    write_json(output / "history-sources.json", [entry])
    write_json(output / "compose.history.yaml", compose)  # JSON is valid YAML.
    (output / "INCOMPLETE.json").unlink()
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    for command in ("inspect", "prepare"):
        child = commands.add_parser(command)
        child.add_argument("source", help="Independent NAS snapshot/export account, db_storage, or single-account parent")
        child.add_argument("--active-root", action="append", required=True, help="Protected active root; repeat for aliases known to this host")
        child.add_argument("--source-kind", choices=("unverified-copy", "nas-snapshot", "offline-export", "synthetic-fixture"), default="unverified-copy")
        child.add_argument("--snapshot-reference", help="Producer snapshot/export reference, kept only in the private report")
        child.add_argument("--captured-at", help="Actual capture time with timezone; never inferred from file mtimes")
        child.add_argument("--confirm-consistent-source", action="store_true", help="Operator assertion about an actual consistent snapshot/export, not a hot-copy bypass")
        child.add_argument("--allow-plaintext", action="store_true")
        child.add_argument("--keys-file", help="Optional existing protected key file; not read, copied, or printed")
        child.add_argument("--mode", choices=("copy", "mount"), default="copy", help="copy DB+WAL or generate a direct read-only snapshot mount")
        child.add_argument("--normalize-plaintext", action="store_true", help="Recover/backup only the new private plaintext copy using SQLite")
        if command == "prepare":
            child.add_argument("--output", required=True, help="New private bundle directory; never overwrite")
            child.add_argument("--id", default="wechat-archive")
            child.add_argument("--display-name", default="微信历史副本")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.command == "prepare" and (not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.id) or not args.display_name.strip() or len(args.display_name) > 160):
        print(json.dumps({"ok": False, "code": "invalid_label"}))
        return 2
    try:
        report = prepare(args)
        # No source paths, account directory names, reference text or key material.
        summary = {key: report[key] for key in ("databaseCount", "plaintextCount", "encryptedOrUnknownCount", "walCount", "shmObserved", "metadataStable", "plaintextNormalized", "readyForReader", "blockers")}
        print(json.dumps({"ok": True, "command": args.command, **summary}, ensure_ascii=False))
        return 0 if report["readyForReader"] else 3
    except PreparationError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": str(error)}))
    except (OSError, ValueError):
        print(json.dumps({"ok": False, "code": "io", "message": MESSAGES["io"]}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
