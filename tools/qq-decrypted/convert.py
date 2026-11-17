#!/usr/bin/env python3
"""Independent, already-decrypted QQNT SQLite -> private SnSBox JSON bundle.

No live-source discovery, decryption, account login or network operations.
SQLite is opened only on our own private copy, never on the input file.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import time

from vendor.qq_message import _extract_msg_text

FORMAT = "snsbox-qq-decrypted-v1"
MAX_DB = 2 * 1024**3
MAX_JSON = 64 * 1024**2
MAX_ROWS = 100_000
MAX_BODY = 4 * 1024**2
MAX_TEXT = 64 * 1024
TABLES = (("c2c_msg_table", "direct", "40030"), ("group_msg_table", "group", "40021"))


class Refused(Exception):
    pass


def overlaps(a: Path, b: Path) -> bool:
    return a == b or a in b.parents or b in a.parents


def identity(value: str) -> bool:
    return bool(value.strip()) and len(value.encode("utf-8")) <= 512 and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def no_links(path: Path) -> None:
    for item in (path, *path.parents):
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise Refused("linked_path_refused")


def stamp(info: os.stat_result) -> tuple:
    # Python/Windows path stat and fd stat can expose different ctime meanings
    # (creation vs change time). File ID, size and mtime agree on both handles.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns if os.name != "nt" else None


def sidecars(path: Path) -> bool:
    return any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal"))


def preflight(args) -> tuple[Path, Path, Path]:
    if not args.confirmed_independent_copy:
        raise Refused("independent_copy_confirmation_required")
    if not identity(args.account_id) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.source_id):
        raise Refused("invalid_identity")
    source = Path(os.path.abspath(args.database))
    output = Path(os.path.abspath(args.output_dir))
    scratch = Path(tempfile.gettempdir())
    # Lexical guards precede any access to the input or protected roots.
    guards = [Path(os.path.abspath(value)) for value in args.active_root]
    if os.name == "nt":
        guards.extend(Path(value) for value in (r"X:\Docker\selkies", r"X:\Docker\wechat"))
    if any(overlaps(path, guard) for path in (source, output) for guard in guards) or any(scratch == guard or guard in scratch.parents for guard in guards):
        raise Refused("protected_path_overlap")
    for path in (source, output, scratch):
        no_links(path)
    source = source.resolve(strict=True)
    output = output.resolve(strict=False)
    scratch = scratch.resolve(strict=True)
    if output.exists() or not output.parent.is_dir():
        raise Refused("output_must_be_new_directory_with_existing_parent")
    if overlaps(source.parent, output) or scratch == source.parent or source.parent in scratch.parents:
        raise Refused("input_output_or_scratch_overlap")
    info = source.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DB or info.st_nlink != 1:
        raise Refused("input_not_regular_independent_bounded_file")
    if sidecars(source):
        raise Refused("sidecar_present_need_completed_checkpointed_export")
    return source, output, scratch


def private_copy(source: Path, target: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(source, flags), "rb") as reader:
        before = os.fstat(reader.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_DB or before.st_nlink != 1:
            raise Refused("input_changed")
        header = reader.read(16)
        if header != b"SQLite format 3\0":
            raise Refused("not_decrypted_sqlite")
        with open(target, "xb") as writer:
            os.chmod(target, 0o600)
            writer.write(header)
            copied = len(header)
            while chunk := reader.read(1024 * 1024):
                copied += len(chunk)
                if copied > MAX_DB:
                    raise Refused("input_size_limit")
                writer.write(chunk)
        if copied != before.st_size or stamp(before) != stamp(os.fstat(reader.fileno())) or stamp(before) != stamp(source.stat()) or sidecars(source):
            raise Refused("input_changed_or_sidecar_appeared")


def rows(connection: sqlite3.Connection, account: str, report: dict):
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    found = False
    for table, kind, peer_column in TABLES:
        if table not in tables:
            continue
        found = True
        columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
        if not {peer_column, "40033", "40050", "40800"}.issubset(columns):
            raise Refused("unsupported_qqnt_numeric_column_schema")
        report["tables"].append(table)
        optional = lambda name: f'"{name}"' if name in columns else "NULL"
        # Bound each cell before Python materializes it; no untrusted SQL names.
        sql = f'''SELECT rowid, {optional("40001")}, "40050",
            CASE WHEN length(CAST("{peer_column}" AS TEXT)) <= 512 THEN CAST("{peer_column}" AS TEXT) END,
            CASE WHEN length(CAST("40033" AS TEXT)) <= 32 THEN "40033" END,
            CASE WHEN length(CAST({optional("40090")} AS BLOB)) <= 4096 THEN {optional("40090")} END,
            CASE WHEN typeof("40800")='blob' AND length("40800") <= {MAX_BODY} THEN "40800" END,
            CASE WHEN length("40800") > {MAX_BODY} THEN 1 ELSE 0 END
            FROM "{table}" ORDER BY rowid LIMIT {MAX_ROWS + 1}'''
        for rowid, msg_id, timestamp, peer, sender, sender_name, body, oversized in connection.execute(sql):
            report["messages"] += 1
            if report["messages"] > MAX_ROWS:
                raise Refused("message_count_limit")
            try:
                timestamp = float(timestamp)
            except (ValueError, TypeError):
                raise Refused("invalid_timestamp") from None
            if not math.isfinite(timestamp) or not 0 < timestamp < 253_402_300_800 or not isinstance(peer, str) or not identity(peer):
                raise Refused("invalid_timestamp_or_conversation")
            content, failure = "", None
            if oversized:
                failure = "body_limit"
            elif not body:
                failure = "body_unavailable"
            else:
                try:
                    content = _extract_msg_text(body)
                except Exception:
                    failure = "body_unsupported"
                if not content.strip():
                    failure = "body_unsupported"
                elif len(content.encode("utf-8")) > MAX_TEXT:
                    failure = "text_limit"
            if failure:
                content = ""
                report["unreadable"] += 1
                report["unreadableReasons"][failure] = report["unreadableReasons"].get(failure, 0) + 1
            else:
                report["decoded"] += 1
                report["maxTextBytes"] = max(report["maxTextBytes"], len(content.encode("utf-8")))
            sender_number = None
            if isinstance(sender, int) and 0 < sender < 2**64:
                sender_number = sender
            elif isinstance(sender, str) and sender.isascii() and sender.isdigit() and 0 < int(sender) < 2**64:
                sender_number = int(sender)
            record = dict(account_id=account, conversation_id=peer, chat_uid=peer,
                conversation_type=kind, chat_kind="group" if kind == "group" else "friend",
                is_group_chat=kind == "group", ts=timestamp, content=content,
                sender_qq=sender_number, sender_name=sender_name if isinstance(sender_name, str) else None,
                msg_id=str(msg_id) if isinstance(msg_id, int) else None,
                source_offset=f"qq_db:{table}:{rowid}",
                decode_status="unreadable" if failure else "decoded", decode_error_code=failure)
            yield record
    if not found:
        raise Refused("no_supported_qqnt_message_tables")


def write_json(path: Path, value) -> None:
    with open(path, "x", encoding="utf-8", newline="\n") as writer:
        os.chmod(path, 0o600)
        json.dump(value, writer, ensure_ascii=False, indent=2, allow_nan=False)
        writer.write("\n")


def convert(args) -> dict:
    source, output, scratch = preflight(args)
    report = dict(format=FORMAT, messages=0, decoded=0, unreadable=0, unreadableReasons={},
        tables=[], maxTextBytes=0, textByteLimit=MAX_TEXT, bodyByteLimit=MAX_BODY,
        allSupportedTableRows=True, timeFilterApplied=False, attachmentsImported=False,
        sourceWritten=False, metadataStableDuringCopy=True, plaintextCopyOnly=True, richContentIsSummary=True)
    with tempfile.TemporaryDirectory(prefix="snsbox-qq-decrypted-", dir=scratch) as temp:
        os.chmod(temp, 0o700)
        copied = Path(temp) / "nt_msg.db"
        private_copy(source, copied)
        connection = sqlite3.connect(copied.as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute("PRAGMA temp_store=MEMORY")
            connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_BODY + 128 * 1024)
            deadline = time.monotonic() + 120
            connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
            output.mkdir(mode=0o700)
            try:
                pending = output / "qq_messages.json.partial"
                with open(pending, "xb") as writer:
                    os.chmod(pending, 0o600)
                    writer.write(b"[\n")
                    byte_count = 2
                    for index, record in enumerate(rows(connection, args.account_id, report)):
                        encoded = ((",\n" if index else "") + json.dumps(record, ensure_ascii=False, allow_nan=False)).encode("utf-8")
                        byte_count += len(encoded)
                        if byte_count + 3 > MAX_JSON:
                            raise Refused("json_size_limit")
                        writer.write(encoded)
                    writer.write(b"\n]\n")
                pending.rename(output / "qq_messages.json")
                write_json(output / "report.json", report)
                # Publish the usable manifest last, after the entire export succeeds.
                write_json(output / "history-sources.json", [dict(id=args.source_id, platform="qq",
                    displayName="QQ 明文历史", format=FORMAT,
                    profilePath=args.container_path or str(output / "qq_messages.json"),
                    confirmedConsistentSnapshot=True, capturedAt=dt.datetime.now(dt.timezone.utc).isoformat())])
            except BaseException:
                # Only our newly created, fixed-name outputs; never recurse a source.
                for name in ("qq_messages.json.partial", "qq_messages.json", "report.json", "history-sources.json"):
                    (output / name).unlink(missing_ok=True)
                output.rmdir()
                raise
        finally:
            connection.close()
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--database", required=True)
    result.add_argument("--account-id", required=True)
    result.add_argument("--output-dir", required=True)
    result.add_argument("--active-root", action="append", required=True)
    result.add_argument("--confirmed-independent-copy", action="store_true")
    result.add_argument("--source-id", default="qq-decrypted")
    result.add_argument("--container-path")
    return result


def main() -> int:
    try:
        report = convert(parser().parse_args())
        print(json.dumps({"ok": True, **report}, ensure_ascii=False))
        return 0
    except Refused as error:
        print(json.dumps({"ok": False, "error": str(error)}))
    except (OSError, sqlite3.Error, ValueError, UnicodeError):
        print(json.dumps({"ok": False, "error": "conversion_failed_no_source_changes"}))
    return 2


if __name__ == "__main__":
    sys.exit(main())
