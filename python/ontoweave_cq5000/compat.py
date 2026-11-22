"""Existing JS signature compatibility, not a second canonical JSON definition.

All old object digests go through the PG-owned batch bridge. Raw bytes always
have a separate UTF-8/byte SHA; Python JSON serialization never replaces them.
"""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading
from .errors import need

ROOT = Path(__file__).resolve().parents[2]
JS_SPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
SPACE_RE = re.compile('[' + re.escape(JS_SPACE) + ']+')
clone = copy.deepcopy


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else bytes(value)).hexdigest()


def dump(value):
    """New Python projection/bundle identity ONLY, following PG contract v1."""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def trim(value):
    return value.strip(JS_SPACE)


def text_field(value):
    if not isinstance(value, str) or not trim(value):
        return False
    try:
        value.encode('utf-16-le', 'surrogatepass').decode('utf-16-le')
    except UnicodeError:
        return False
    return True


def normalized_question(value):
    return trim(SPACE_RE.sub(' ', value))


def js_keys(value):
    """Object.keys puts array-index properties first, even after JSON parsing."""
    keys = list(value)
    index = lambda k: isinstance(k, str) and k.isascii() and k.isdigit() and str(int(k)) == k and int(k) < 4294967295
    return sorted((k for k in keys if index(k)), key=int) + [k for k in keys if not index(k)]


class LegacyHasher:
    """Read-only PG-owned bridge. Batch/cache calls, no JS CQ execution."""
    def __init__(self, bridge=None):
        self.bridge = Path(bridge or ROOT / 'scripts/pg-cq-legacy-hash.mjs')
        self._cache = {}
        self._lock = threading.RLock()

    def many(self, values):
        with self._lock:
            keys = [dump(v) for v in values]
            missing = dict.fromkeys(k for k in keys if k not in self._cache)
            if missing:
                proc = subprocess.run(['node', str(self.bridge)], input=dump([json.loads(k) for k in missing]),
                                      text=True, capture_output=True, timeout=30, check=False, cwd=ROOT)
                need(proc.returncode == 0, 'PG_CQ_LEGACY_HASH_BRIDGE_FAILED')
                hashes = json.loads(proc.stdout)
                need(len(hashes) == len(missing) and all(isinstance(h, str) and re.fullmatch('[0-9a-f]{64}', h) for h in hashes),
                     'PG_CQ_LEGACY_HASH_BRIDGE_INVALID')
                self._cache.update(zip(missing, hashes))
            return [self._cache[k] for k in keys]

    def digest(self, value):
        return self.many([value])[0]


DEFAULT_HASHER = LegacyHasher()


def distinct(values, hasher=DEFAULT_HASHER):
    result = {}
    for key, value in zip(hasher.many(values), values):
        result[key] = value  # Last value, first insertion order: JS Map semantics.
    return list(result.values())
