# Vendored QQ message parser

- Upstream: [chatlog-keeper / qq_db.py](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/qq_db.py)
- Fixed commit: `d2feeec09a192af9a4738547b8543cf096386464`; MIT, copyright 2026 labazhou2024. License retained alongside this file.
- Selected upstream lines 1323–1861: `_proto_varint`, `_proto_parse`, message field constants, `_extract_msg_text`. No credential discovery, process access, cryptography, SQLCipher, SQLite lifecycle, upstream CLI, attachment-path extractor or network code is included.
- Local changes: remove final `[:1000]` truncation; preserve leading/trailing text whitespace; replace brute UTF-8 fallback with an empty result (caller retains an unreadable placeholder). Ordinary primary text (45101 inside 40800) is therefore not length-truncated by the parser. Adapter imposes a separate explicit 64 KiB UTF-8 ceiling.
- Upstream rich-message presentation remains a summary: reply preview 120 chars, selected card/system labels shorter, unknown nesting limited to depth 3; adjacent identical parts may be coalesced. This is not a lossless reconstruction of every QQ message or attachment.
- SQL schema field IDs in `convert.py` follow the same file's `_NTQQ_COL_*` definitions (2121–2129). SQLite queries and file isolation are SnSBox adapters, not new private-protocol decoding.
- WeQ source was examined for context but not copied; its checked-in license is CC BY-NC-SA 4.0. This tool depends only on Python's standard library and the MIT parser above.
