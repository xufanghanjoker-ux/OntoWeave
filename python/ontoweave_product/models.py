"""A deployment-owned credential shared by the registered product providers."""
import os
from pathlib import Path
from stat import S_ISDIR, S_ISREG
from tempfile import NamedTemporaryFile

from ontoweave_publication.runtime import _credential
from ontoweave_publication.store import require


class ProductModelSettings:
    def __init__(self, path, mode):
        require(path and Path(path).is_absolute(), "MODEL_SETTINGS_CREDENTIAL_PATH_REQUIRED", 503)
        self.path = Path(path)
        self.mode = mode
        directory = self.path.parent.lstat()
        require(S_ISDIR(directory.st_mode) and directory.st_uid == os.getuid() and not directory.st_mode & 0o077,
                "MODEL_SETTINGS_DIRECTORY_NOT_PRIVATE", 503)
        self.store = None
        self.models = {}

    def credential(self):
        try:
            return _credential(None, self.path)
        except (OSError, UnicodeError):
            require(False, "MODEL_SETTINGS_CREDENTIAL_REQUIRED", 503)

    def ready(self):
        if self.mode != "REAL":
            return True
        return self._present()

    def _present(self):
        from ontoweave_publication.store import PublicationError

        try:
            return bool(self.credential())
        except PublicationError:
            return False

    def status(self):
        present = self._present()
        models = {role: dict(value) for role, value in self.models.items()}
        if self.mode == "REAL" and not present:
            for role in ("generation", "embedding"):
                models[role]["configured"] = False
        return dict(models=models, can_save=True, credential_configured=present, mode=self.mode,
                    provider="QWEN_BEIJING" if self.mode=="REAL" else "NATIVE_SIM")

    def save(self, api_key):
        value = api_key.strip()
        require(0 < len(value) <= 4096 and all(33 <= ord(char) <= 126 for char in value),
                "MODEL_SETTINGS_CREDENTIAL_INVALID", 422)
        with self.store.transaction() as (q, _):
            hold_model_configuration(q)
            busy = q("""SELECT EXISTS (
                SELECT 1 FROM publication_v1.builds
                WHERE body->>'execution_status' IN ('QUEUED','RUNNING')
                UNION ALL SELECT 1 FROM publication_v1.jobs WHERE status IN ('QUEUED','RUNNING')
                ) AS busy""").fetchone()["busy"]
            require(not busy, "MODEL_SETTINGS_WORK_IN_PROGRESS")
            if self.path.exists() or self.path.is_symlink():
                current = self.path.lstat()
                require(S_ISREG(current.st_mode) and current.st_uid == os.getuid()
                        and not current.st_mode & 0o077, "MODEL_SETTINGS_CREDENTIAL_NOT_PRIVATE", 503)
            with NamedTemporaryFile("wb", dir=self.path.parent, prefix=".model-", delete=False) as stream:
                pending = Path(stream.name)
                try:
                    stream.write(value.encode("ascii") + b"\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                    os.replace(pending, self.path)
                finally:
                    pending.unlink(missing_ok=True)
        return self.status()


def hold_model_configuration(q):
    q("SELECT pg_advisory_xact_lock(hashtext('ontoweave-product-model-settings'))")
