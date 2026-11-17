#!/usr/bin/env python3
"""Create ONLY new synthetic QQNT numeric-column SQLite databases for tests."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3

LONG_TAIL = "SNSBOX_QQ_LONG_TAIL_20261117"
LONG_TEXT = "长" * 5000 + " " + LONG_TAIL
SEARCH_PREFIX = "QQ decrypted fixture row"
BASE_TIME = 1_794_900_000


def varint(value: int) -> bytes:
    # Test-only protobuf encoder. Production parsing is the vendored upstream.
    output = bytearray()
    while value > 127:
        output.append((value & 127) | 128)
        value >>= 7
    output.append(value)
    return bytes(output)


def field(number: int, value: bytes) -> bytes:
    return varint(number * 8 + 2) + varint(len(value)) + value


def text_body(value: str) -> bytes:
    return field(40800, field(45101, value.encode("utf-8")))


def create_database(directory: Path, account: int, large: bool) -> dict:
    directory.mkdir(mode=0o700)
    database = directory / "nt_msg.db"
    connection = sqlite3.connect(database)
    try:
        for table in ("c2c_msg_table", "group_msg_table"):
            connection.execute(f'''CREATE TABLE "{table}" (
                "40001" INTEGER, "40050" INTEGER, "40030" INTEGER, "40021" INTEGER,
                "40033" INTEGER, "40090" TEXT, "40800" BLOB)''')
        def insert(table: str, index: int, body: bytes, when: int, sender: int = 90002):
            connection.execute(f'INSERT INTO "{table}" VALUES(?,?,?,?,?,?,?)',
                (9007199254740993 + index, when, 90002, 90002, sender, "合成发送者", body))
        count = 120 if large else 1
        for index in range(count):
            content = LONG_TEXT if large and index == 0 else f"{SEARCH_PREFIX} {index}"
            # Two distinct rows at the same second; no content-hash deduplication.
            when = BASE_TIME + (1 if index == 2 else index)
            insert("c2c_msg_table", index, text_body(content), when, account if index == 3 else 90002)
        insert("group_msg_table", 1000, text_body("合成同号群聊"), BASE_TIME + 150)
        if large:
            insert("c2c_msg_table", 1001, field(40800, field(77777, b"https://never-fetch.invalid/private-token")), BASE_TIME + 151)
            insert("c2c_msg_table", 1002, b"\xff", BASE_TIME + 152)
            insert("c2c_msg_table", 1003, field(40800, field(45402, b"synthetic-image.png")), BASE_TIME + 153)
        connection.commit()
    finally:
        connection.close()
    os.chmod(database, 0o600)
    return dict(accountId=str(account), database=f"{directory.name}/nt_msg.db",
        messages=124 if large else 2, conversations=2, decoded=122 if large else 2,
        unreadable=2 if large else 0, longTextCharacters=len(LONG_TEXT) if large else 0)


def create(output: Path) -> dict:
    output = Path(os.path.abspath(output))
    if os.name == "nt":
        for protected in (Path(r"X:\Docker\selkies"), Path(r"X:\Docker\wechat")):
            if output == protected or protected in output.parents or output in protected.parents:
                raise ValueError("protected fixture destination")
    # Never overwrite or reuse a directory, and never generate under a link.
    for path in (output, *output.parents):
        if path.is_symlink() or (path.exists() and getattr(path.lstat(), "st_file_attributes", 0) & 0x400):
            raise ValueError("linked fixture destination")
    output.mkdir(mode=0o700)
    report = dict(syntheticOnly=True, longTailMarker=LONG_TAIL, searchPrefix=SEARCH_PREFIX,
        accounts={"account-a": create_database(output / "account-a", 10001, True),
                  "account-b": create_database(output / "account-b", 20001, False)})
    target = output / "fixture-report.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(target, 0o600)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(create(Path(args.output_dir)), ensure_ascii=False))
    except (OSError, ValueError, sqlite3.Error):
        print(json.dumps({"ok": False, "error": "fixture_creation_failed_no_overwrite"}))
        raise SystemExit(2)
