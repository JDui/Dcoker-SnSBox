# Derived from chatlog-keeper qq_db.py, commit d2feeec09a192af9a4738547b8543cf096386464.
# Copyright (c) 2026 labazhou2024. MIT; see LICENSE.chatlog-keeper and SOURCES.md.
# Pure parsing only: no database, files, credentials, memory, network or CLI code.
from typing import Dict, List, Optional, Tuple

def _proto_varint(data: bytes, off: int) -> Tuple[Optional[int], int]:
    """Decode a protobuf varint at offset. Returns (value, new_offset)."""
    val = 0
    shift = 0
    while off < len(data):
        b = data[off]
        off += 1
        val |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return val, off
        shift += 7
        if shift > 70:
            return None, off
    return None, off


def _proto_parse(data: bytes) -> Dict[int, list]:
    """Parse protobuf wire format. Returns {field_num: [(wire_type_tag, value)]}.

    Tolerant: stops on first parse error, keeps already-extracted fields.
    Wire types: 0=varint, 1=fixed64, 2=length-delimited, 5=fixed32.
    """
    fields: Dict[int, list] = {}
    off = 0
    while off < len(data):
        tag, off = _proto_varint(data, off)
        if tag is None:
            break
        wt = tag & 7
        fnum = tag >> 3
        try:
            if wt == 0:
                v, off = _proto_varint(data, off)
                if v is None:
                    break
                fields.setdefault(fnum, []).append(("varint", v))
            elif wt == 2:
                ln, off = _proto_varint(data, off)
                if ln is None or ln < 0 or off + ln > len(data):
                    break
                fields.setdefault(fnum, []).append(("bytes", data[off:off + ln]))
                off += ln
            elif wt == 5:
                fields.setdefault(fnum, []).append(("fixed32", data[off:off + 4]))
                off += 4
            elif wt == 1:
                fields.setdefault(fnum, []).append(("fixed64", data[off:off + 8]))
                off += 8
            else:
                break
        except Exception:
            break
    return fields


# NTQQ msgBody (col 40800) protobuf field IDs.
#
# Reverse-engineered from live-decoded samples + an empirical field inventory:
# the 4-field set already covers 100% of observed msgs (0 empty narratives,
# 0 URL leaks). Below we keep the high-confidence 4 fields + add image
# dimension extraction (45411/45412) for richer narrative, and add an explicit
# skip-list for media-metadata fields that must NEVER leak to text.
#
# Outer wrapper field that ALL msg_body BLOBs begin with:
_NTQQ_MSG_OUTER_WRAPPER = 40800

# Inner fields (after unwrapping 40800):
_NTQQ_MSG_TEXT_PRIMARY = 45101       # 主文本 content (text+reply inner)
_NTQQ_MSG_REPLY_CONTAINER = 47423    # reply wrapper; nested 45101 = quoted text
_NTQQ_MSG_IMAGE_FILENAME = 45402     # image filename .jpg/.png/.gif (also file/voice names)
_NTQQ_MSG_IMAGE_WIDTH = 45411        # image width px (varint)
_NTQQ_MSG_IMAGE_HEIGHT = 45412       # image height px (varint)
_NTQQ_MSG_SENDER_UID_NESTED = 40020  # sender uid string (u_xxx) inside body

# Large-account inventory expansion — ALL msg types from a stratified sample
# of a multi-GB nt_msg.db (per-combo deep dive):
_NTQQ_MSG_FILE_SIZE = 45405          # file/image size (varint, bytes)
_NTQQ_MSG_FILE_LOCAL_PATH = 45403    # file local path (NTQQ ::NTOSFull:: prefix)
_NTQQ_MSG_FILE_MD5_BIN = 45406       # 16-byte md5 (image+voice+file)
_NTQQ_MSG_FILE_MD5_ALT = 45407       # 16-byte md5 (file-only variant)
_NTQQ_MSG_FILE_SDK_VERSION = 45550   # 1=file, 4=voice (sub-type discriminator)
_NTQQ_MSG_VOICE_DURATION_MS = 45906  # voice duration in ms (when 45550=4)
_NTQQ_MSG_VOICE_FORMAT = 45907       # voice format (1=amr)

# Sticker / face (msg_class=17, msg_subtype=8) — "super face"
_NTQQ_MSG_FACE_ID = 80810            # face_id (varint, e.g. 209590)
_NTQQ_MSG_FACE_HASH = 80824          # face hash (utf8 hex)
_NTQQ_MSG_FACE_NAME = 80900          # display text '[骰子]' '[掀桌]' etc
_NTQQ_MSG_FACE_MD5 = 80903           # 16-byte md5

# Ark/markdown application messages (msg_class=11, msg_subtype=0)
_NTQQ_MSG_ARK_JSON = 47901           # JSON payload {"app": "com.tencent.video.lua", ...}

# Merged forward (msg_class=8, msg_subtype=0)
_NTQQ_MSG_MERGED_PREVIEW = 48601     # base64 preview blob
_NTQQ_MSG_MERGED_XML = 48602         # XML msg list (full content)
_NTQQ_MSG_MERGED_GUID = 48603        # UUID

# Reply / react with emoji (msg_class=5, msg_subtype=4)
_NTQQ_MSG_REACT_REPLY_GROUP = 47702  # react group base
# 47703/47704 = sender uids; 47705/47714 = display labels '回应'/emoji
_NTQQ_MSG_REACT_LABEL_FROM = 47705
_NTQQ_MSG_REACT_LABEL_TO = 47714
_NTQQ_MSG_REACT_EMOJI = 47706

# Pai-yi-pai 戳一戳 (msg_class=9, msg_subtype=33)
_NTQQ_MSG_PAI_GROUP = 47401          # base — 47419=action(47=戳), 47413='我戳了你的游戏'

# System gtip (msg_class=5, msg_subtype=12)
_NTQQ_MSG_GTIP_XML = 48214           # <gtip><nor>记为验证消息</nor>
_NTQQ_MSG_GTIP_JSON = 48271          # JSON {align,items} alt

# Quoted nested ref (49154/49155 — appears in msg_subtype=17 reply chain)
_NTQQ_MSG_QUOTE_NESTED_TAG = 49154   # utf8 'nt_1'
_NTQQ_MSG_QUOTE_NESTED_TS = 49155    # quoted msg timestamp

# Fields that contain media-pipeline metadata (CDN URLs, aeskey, md5, etc.)
# and MUST NEVER be emitted as narrative — the brute UTF-8 fallback would
# happily decode them otherwise. Explicit skip-list prevents URL leak.
_NTQQ_MSG_MEDIA_META_SKIP = frozenset({
    45406,  # image/file/voice md5 (16 bytes binary)
    45407,  # file md5 alt
    45408,  # image SHA1 (20 bytes)
    45416,  # image flag varint
    45418,  # image flag varint
    45424,  # alt filename (sometimes duplicate of 45402)
    45503,  # image url metadata wrapper (base64 token)
    45504,  # file/image alt token D6EA...
    45505,  # image timestamp
    45511,  # image flag varint
    45513,  # image flag varint
    45517,  # ts varint
    45518,  # ttl varint
    45802,  # CDN download URL primary
    45803,  # CDN download URL alt1
    45804,  # CDN download URL alt2
    45815,  # (empty in obs samples)
    45816,  # multimedia.nt.qq.com.cn hostname
    45817,  # CDN config flag
    45818,  # CDN config empty
    45821,  # CDN config flag
    45822,  # CDN config flag
    45906,  # voice 'flag' varint (24 in samples — NOT duration, kept for analysis only)
    45907,  # voice format flag
    45909,  # voice CDN flag
    45911,  # voice CDN flag
    45922,  # voice flag
    47702,  # react flag
    47703,  # react sender uid
    47704,  # react receiver uid
    47705,  # react sender nickname (NOT emoji)
    47706,  # react extra label
    47710,  # react md5
    47711,  # react flag
    47713,  # react bytes
    47714,  # react receiver nickname (NOT emoji)
    48212,  # gtip seq
    48213,  # gtip flag
    48215,  # gtip msg seq
    48216,  # gtip ts
    48217,  # client metadata wrapper
    48218,  # gtip extra
    48272,  # gtip JSON 1
    48273,  # gtip JSON 2
    47402,  # pai 戳一戳 ts/seq
    47403,  # pai sender uin
    47404,  # pai ts
    47411,  # pai flag
    47416,  # pai flag
    47422,  # pai ref ts
    49155,  # quote nested ts
    80810,  # face_id raw (covered via _NTQQ_MSG_FACE_ID handler)
    80824,  # face hash hex
    80901, 80902, 80905, 80908, 80909, 80910,  # face dims/flags
})


def _extract_msg_text(blob: bytes) -> str:
    """Extract human-readable text from NTQQ msgBody (col 40800) protobuf BLOB.

    Real protobuf decode replaces brute UTF-8. Coverage:
      - text  (45101) — chat 内容主要载体
      - reply (47423.45101) — [引用: …] 引用消息
      - image (45402) — [图片: filename.jpg WxH]
      - sender_uid (40020) — skip (not user-facing)
      - media-meta (45406/45503/45802/45816/etc) — explicit skip (no URL leak)
      - unknown nested → recurse depth-3 → fallback brute UTF-8

    A field-inventory analysis showed this 4-field decode covers 100% of real
    msgs. Image dimension capture (45411 width, 45412 height) enriches the
    image narrative; the explicit media-meta skip list
    (_NTQQ_MSG_MEDIA_META_SKIP) prevents CDN URL leak via the brute fallback.

    Returns "" when BLOB has zero recoverable text.
    """
    if not blob:
        return ""
    parts: List[str] = []
    fields = _proto_parse(blob)

    def _collect(fdict: Dict[int, list], depth: int = 0,
                 image_w: List[Optional[int]] = None,
                 image_h: List[Optional[int]] = None) -> None:
        if depth > 3:
            return
        for fnum in sorted(fdict.keys()):
            for (typ, val) in fdict[fnum]:
                # Capture image dims even when wire_type=varint
                if typ == "varint" and fnum == _NTQQ_MSG_IMAGE_WIDTH and image_w is not None:
                    if image_w and image_w[0] is None:
                        image_w[0] = int(val)
                    continue
                if typ == "varint" and fnum == _NTQQ_MSG_IMAGE_HEIGHT and image_h is not None:
                    if image_h and image_h[0] is None:
                        image_h[0] = int(val)
                    continue
                if typ != "bytes":
                    continue
                if fnum == _NTQQ_MSG_TEXT_PRIMARY:
                    try:
                        parts.append(val.decode("utf-8"))
                        continue
                    except UnicodeDecodeError:
                        pass
                if fnum == _NTQQ_MSG_REPLY_CONTAINER:
                    # Mirror wechat `_format_refermsg` — recurse into nested
                    # filename (45402) to detect a quoted image/file/voice, not
                    # just text (45101). Emit `[引用 <kind>: <filename>]` for
                    # nested attachments instead of a bare `[引用: <text>]`.
                    sub = _proto_parse(val)
                    quoted_atts: List[str] = []
                    quoted_texts: List[str] = []
                    for sfn, svals in sub.items():
                        # nested filename (image/file/voice)
                        if sfn == _NTQQ_MSG_IMAGE_FILENAME:
                            for (st, sv) in svals:
                                if st == "bytes":
                                    try:
                                        fname = sv.decode("utf-8", errors="replace")
                                        ext = (fname.lower().rsplit(".", 1)[-1]
                                               if "." in fname else "")
                                        if ext in ("amr", "silk"):
                                            quoted_atts.append(f"[语音 {fname}]")
                                        elif ext in ("mp4", "mov", "avi", "mkv"):
                                            quoted_atts.append(f"[视频 {fname}]")
                                        elif ext in ("pdf", "docx", "doc", "xlsx",
                                                     "xls", "pptx", "ppt", "zip",
                                                     "rar", "7z", "txt", "csv"):
                                            quoted_atts.append(f"[文件 {fname}]")
                                        else:
                                            quoted_atts.append(f"[图片 {fname}]")
                                    except UnicodeDecodeError:
                                        pass
                        # quoted text
                        elif sfn == _NTQQ_MSG_TEXT_PRIMARY:
                            for (_, sv) in svals:
                                if not isinstance(sv, (bytes, bytearray)):
                                    continue
                                try:
                                    quoted_texts.append(sv.decode("utf-8"))
                                except UnicodeDecodeError:
                                    pass
                    body_parts = quoted_atts + quoted_texts
                    if body_parts:
                        body = " ".join(body_parts)[:120]
                        parts.append(f"[引用: {body}]")
                    continue
                if fnum == _NTQQ_MSG_IMAGE_FILENAME:
                    # 45402 carries image OR file OR voice filename —
                    # discriminate by sibling fields:
                    #   - sibling 45550=4 → voice (.amr)
                    #   - sibling 45403 present OR 45411/12 both 0 → file
                    #   - otherwise → image (with w/h)
                    try:
                        name = val.decode("utf-8", errors="replace")
                        # Probe sibling fields for type discrimination
                        sibling_w = [None]
                        sibling_h = [None]
                        sibling_size = [None]
                        sibling_local_path = [None]
                        sibling_sdk_ver = [None]
                        sibling_voice_ms = [None]
                        for sf, svs in fdict.items():
                            if sf == _NTQQ_MSG_IMAGE_WIDTH:
                                for (st, sv) in svs:
                                    if st == "varint":
                                        sibling_w[0] = int(sv); break
                            elif sf == _NTQQ_MSG_IMAGE_HEIGHT:
                                for (st, sv) in svs:
                                    if st == "varint":
                                        sibling_h[0] = int(sv); break
                            elif sf == _NTQQ_MSG_FILE_SIZE:
                                for (st, sv) in svs:
                                    if st == "varint":
                                        sibling_size[0] = int(sv); break
                            elif sf == _NTQQ_MSG_FILE_LOCAL_PATH:
                                for (st, sv) in svs:
                                    if st == "bytes":
                                        try:
                                            sibling_local_path[0] = sv.decode("utf-8", errors="replace")
                                        except Exception:
                                            pass
                                        break
                            elif sf == _NTQQ_MSG_FILE_SDK_VERSION:
                                for (st, sv) in svs:
                                    if st == "varint":
                                        sibling_sdk_ver[0] = int(sv); break
                            elif sf == _NTQQ_MSG_VOICE_DURATION_MS:
                                for (st, sv) in svs:
                                    if st == "varint":
                                        sibling_voice_ms[0] = int(sv); break

                        def _fmt_size(n: Optional[int]) -> str:
                            if not n:
                                return ""
                            if n < 1024:
                                return f"{n}B"
                            if n < 1024 * 1024:
                                return f"{n / 1024:.1f}KB"
                            return f"{n / 1024 / 1024:.1f}MB"

                        # Voice: STRICT — only if (a) filename ends with .amr/.silk
                        # OR (b) sdk_ver=4 AND has voice metadata (45906/45907 present).
                        # 2026-05-23: too-loose check caused image false-positives
                        # because 45550=4 sometimes appears outside voice context.
                        is_voice = name.lower().endswith((".amr", ".silk"))
                        if not is_voice and sibling_sdk_ver[0] == 4 and sibling_voice_ms[0] is not None:
                            is_voice = True
                        if is_voice:
                            sz = _fmt_size(sibling_size[0])
                            # 45906 varies — small ints likely flag, large = ms duration
                            if sibling_voice_ms[0] and sibling_voice_ms[0] > 100:
                                sec = sibling_voice_ms[0] / 1000.0
                                label = f"[语音 {sec:.1f}s {sz}]"
                            else:
                                label = f"[语音 {sz}]"
                            parts.append(label.strip())
                            continue
                        # File: has local_path OR w/h both 0 OR known file ext
                        is_likely_file = (
                            sibling_local_path[0]
                            or (sibling_w[0] == 0 and sibling_h[0] == 0)
                            or name.lower().endswith((".pdf", ".docx", ".doc", ".xlsx", ".xls",
                                                       ".pptx", ".ppt", ".zip", ".rar", ".7z",
                                                       ".exe", ".mp4", ".mov", ".avi", ".mkv",
                                                       ".txt", ".csv", ".rtf"))
                        )
                        if is_likely_file:
                            sz = _fmt_size(sibling_size[0])
                            # Video files get [视频] label, others [文件]
                            if name.lower().endswith((".mp4", ".mov", ".avi", ".mkv", ".webm")):
                                label = f"[视频: {name} {sz}]"
                            else:
                                label = f"[文件: {name} {sz}]"
                            parts.append(label.strip())
                            continue
                        # Image: has w/h
                        if sibling_w[0] and sibling_h[0]:
                            parts.append(f"[图片: {name} {sibling_w[0]}x{sibling_h[0]}]")
                        else:
                            parts.append(f"[图片: {name}]")
                        continue
                    except Exception:
                        pass
                # super face / sticker (msg_class=17, subtype=8)
                if fnum == _NTQQ_MSG_FACE_NAME:
                    try:
                        face_label = val.decode("utf-8", errors="replace").strip()
                        if face_label:
                            # Often comes pre-bracketed like '[骰子]'; if not, add brackets
                            if not (face_label.startswith("[") and face_label.endswith("]")):
                                face_label = f"[表情: {face_label}]"
                            parts.append(face_label)
                            continue
                    except Exception:
                        pass
                # Ark/markdown application messages
                if fnum == _NTQQ_MSG_ARK_JSON:
                    try:
                        ark = val.decode("utf-8", errors="replace")
                        # Parse JSON to extract app + desc + prompt
                        import json as _json
                        try:
                            d = _json.loads(ark)
                            app = d.get("app", "")
                            prompt = d.get("prompt") or d.get("desc") or ""
                            meta = d.get("meta") or {}
                            # Common: video.lua / news / structmsg etc
                            label_parts = []
                            if prompt:
                                label_parts.append(prompt[:80])
                            if app and app not in (prompt or ""):
                                short_app = app.split(".")[-1] if "." in app else app
                                label_parts.append(f"({short_app})")
                            if label_parts:
                                parts.append(f"[小程序: {' '.join(label_parts)}]")
                            else:
                                parts.append("[小程序]")
                        except Exception:
                            parts.append("[小程序]")
                        continue
                    except Exception:
                        pass
                # Merged forward: extract gist from XML
                # Mirror wechat `_format_merged_forward` — parse XML, find
                # dataitems, then inline each (sourcename + datadesc) up to a
                # 500-char budget instead of `[聊天记录: title] (Nitems)`.
                if fnum == _NTQQ_MSG_MERGED_XML:
                    try:
                        xml_str = val.decode("utf-8", errors="replace")
                        # Try strict XML parse first to get dataitems
                        try:
                            import xml.etree.ElementTree as _ET
                            root_xml = _ET.fromstring(xml_str)
                            title_node = root_xml.find(".//title")
                            head_title = (
                                title_node.text.strip()
                                if title_node is not None and title_node.text
                                else "聊天记录"
                            )
                            dataitems = root_xml.findall(".//dataitem")
                            if dataitems:
                                head = f"[聊天记录: {head_title[:50]} | {len(dataitems)}条]"
                                inline_parts = [head]
                                used = len(head)
                                MAX_CHARS = 500
                                for di in dataitems:
                                    sender_node = di.find("sourcename")
                                    desc_node = di.find("datadesc")
                                    sender_txt = (
                                        sender_node.text.strip()[:20]
                                        if sender_node is not None and sender_node.text
                                        else "?"
                                    )
                                    desc_txt = (
                                        desc_node.text.strip()[:80]
                                        if desc_node is not None and desc_node.text
                                        else ""
                                    )
                                    if not desc_txt:
                                        continue
                                    item_str = f" | {sender_txt}: {desc_txt}"
                                    if used + len(item_str) > MAX_CHARS:
                                        inline_parts.append(" | …")
                                        break
                                    inline_parts.append(item_str)
                                    used += len(item_str)
                                parts.append("".join(inline_parts))
                                continue
                        except _ET.ParseError:
                            pass
                        # Fallback to old regex behavior on parse failure
                        import re as _re
                        titles = _re.findall(r"<title[^>]*>([^<]+)</title>", xml_str)
                        msg_cnt = len(_re.findall(r"<msg[^>]", xml_str))
                        if titles:
                            parts.append(f"[聊天记录: {titles[0][:50]}] ({msg_cnt}条消息)")
                        else:
                            parts.append(f"[聊天记录 {msg_cnt}条消息]")
                        continue
                    except Exception:
                        pass
                # Pai 戳一戳: extract action label from 47413
                if fnum == _NTQQ_MSG_PAI_GROUP:
                    try:
                        sub = _proto_parse(val)
                        action_text = None
                        for sfn, svals in sub.items():
                            if sfn == 47413:  # pai action text
                                for (_, sv) in svals:
                                    if isinstance(sv, (bytes, bytearray)):
                                        try:
                                            action_text = sv.decode("utf-8", errors="replace").strip()
                                            break
                                        except Exception:
                                            pass
                                if action_text:
                                    break
                        if action_text:
                            parts.append(f"[戳一戳: {action_text[:40]}]")
                        else:
                            parts.append("[戳一戳]")
                        continue
                    except Exception:
                        pass
                # Sysmsg gtip (system event)
                if fnum == _NTQQ_MSG_GTIP_XML:
                    try:
                        gtip = val.decode("utf-8", errors="replace")
                        # Strip XML tags
                        import re as _re
                        txt = _re.sub(r"<[^>]+>", " ", gtip).strip()
                        if txt:
                            parts.append(f"[系统: {txt[:80]}]")
                            continue
                    except Exception:
                        pass
                # react/回应 (msg_subtype=4) — 47705/47714 turned out to be
                # sender/receiver NICKNAMES (not emoji labels). Without a clear
                # field mapping for the actual emoji, emit a generic
                # placeholder. All 47702-47714 fields are skipped below via the
                # media-meta skip set.
                if fnum == _NTQQ_MSG_SENDER_UID_NESTED:
                    continue
                if fnum in _NTQQ_MSG_MEDIA_META_SKIP:
                    # Explicit skip: media pipeline metadata (URLs, md5, aeskey,
                    # CDN endpoints) — never leak to narrative text.
                    continue
                # Unknown nested — recurse with the same image-dim trackers
                if len(val) >= 4 and depth < 3:
                    sub = _proto_parse(val)
                    if sub:
                        _collect(sub, depth + 1, image_w, image_h)

    _collect(fields, image_w=[None], image_h=[None])

    if not parts:
        # 47702 is a precise reaction/reply marker.  Its nested payload carries
        # native participant metadata that must not be promoted to narrative,
        # but silently dropping the row would make bounded coverage dishonest.
        # Emit one fixed marker only when no structured narrative was decoded.
        reaction_fields = fields
        for wire_type, value in fields.get(_NTQQ_MSG_OUTER_WRAPPER, []):
            if wire_type == "bytes":
                reaction_fields = _proto_parse(value)
                break
        if _NTQQ_MSG_REACT_REPLY_GROUP in reaction_fields:
            return "[回应]"
        # SnSBox: do not promote arbitrary binary metadata into message text.
        return ""

    out: List[str] = []
    for p in parts:
        # SnSBox: preserve leading/trailing whitespace of decoded text.
        if p and (not out or out[-1] != p):
            out.append(p)
    return " ".join(out)
