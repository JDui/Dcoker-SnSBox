# Adapted from chatlog-keeper d2feeec09a192af9a4738547b8543cf096386464.
# See LICENSE.chatlog-keeper and SOURCES.md. SQLCipher authentication only.
import hashlib
import hmac as hmac_mod
import struct
from typing import Optional
_WECHAT_KDF_ITER = 256000

def _hmac_check_pagekey(page_key: bytes, db_page1: bytes) -> bool:
    """Standard SQLCipher-4 page-1 HMAC check given the actual 32-byte AES page key.
    HMAC-SHA512 over page1[16:4032] + LE-u32 page number, key = PBKDF2-HMAC-SHA512(
    page_key, salt^0x3A, fast_kdf_iter=2, 32)."""
    PAGE_SZ = 4096
    SALT_SZ = 16
    try:
        salt = db_page1[:SALT_SZ]
        mac_salt = bytes(b ^ 0x3A for b in salt)
        mac_key = hashlib.pbkdf2_hmac("sha512", page_key, mac_salt, 2, dklen=32)
        hm = hmac_mod.new(mac_key, db_page1[SALT_SZ: PAGE_SZ - 64], hashlib.sha512)
        hm.update(struct.pack("<I", 1))
        return hmac_mod.compare_digest(hm.digest(), db_page1[PAGE_SZ - 64: PAGE_SZ])
    except Exception:
        return False


def _effective_page_key(enc_key: bytes, db_page1: bytes) -> Optional[bytes]:
    """Return the actual AES page key for THIS db (or None if enc_key does not fit),
    validated by the page-1 HMAC. Handles both WeChat key schemes:
      - raw-key mode (WeChat 4.0.x / older): enc_key IS the page key.
      - password mode (WeChat 4.1.10.31+): page key = PBKDF2-HMAC-SHA512(
        enc_key, page1-salt, 256000, 32).
    Per-db: the derived key depends on that db's salt, so a single cached master key
    decrypts every db (each derives its own page key)."""
    if not enc_key or len(enc_key) != 32 or not db_page1 or len(db_page1) < 4096:
        return None
    if _hmac_check_pagekey(enc_key, db_page1):
        return enc_key
    try:
        derived = hashlib.pbkdf2_hmac("sha512", enc_key, db_page1[:16], _WECHAT_KDF_ITER, dklen=32)
        if _hmac_check_pagekey(derived, db_page1):
            return derived
    except Exception:
        pass
    return None
