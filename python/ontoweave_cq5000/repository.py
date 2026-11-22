"""Business record port and offline memory adapter. PG writer belongs elsewhere."""
from contextlib import contextmanager
from typing import Protocol
import threading
from .compat import clone


class RecordRepository(Protocol):
    def get_record(self, kind: str, key: str): ...
    def put_record(self, kind: str, key: str, value: dict): ...
    def transaction(self): ...


class MemoryRecords:
    """Offline/runtime-port simulator; not a database or second PG repository."""
    def __init__(self):
        self.rows = {}
        self._lock = threading.RLock()

    def get_record(self, kind, key):
        with self._lock:
            return clone(self.rows.get((kind, key)))

    def put_record(self, kind, key, value):
        with self._lock:
            self.rows[kind, key] = clone(value)
        return clone(value)

    @contextmanager
    def transaction(self):
        with self._lock:
            before = clone(self.rows)
            try:
                yield self
            except BaseException:
                self.rows = before
                raise
