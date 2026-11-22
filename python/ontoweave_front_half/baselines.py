"""Verify the signed-off source inventory for the packaged workbench."""
import json
import os
from pathlib import Path
import re

from ontoweave_cq5000.compat import ROOT, sha, dump
from ontoweave_cq5000.dispatch import verify_skill
from ontoweave_cq_similarity.core import require

CURRENT_BASELINE = "ontoweave-workbench-0.2.0-alpha.1"
MANIFEST = ROOT / "contracts/workbench-runtime-v1/source.json"


def verify_baseline(baseline=CURRENT_BASELINE):
    require(baseline == CURRENT_BASELINE, "FRONT_HALF_BASELINE_UNKNOWN")
    filename = os.environ.get("ONTOWEAVE_NATIVE_SUCCESSOR_MANIFEST")
    expected = os.environ.get("ONTOWEAVE_NATIVE_SUCCESSOR_SHA256", "")
    require(bool(filename) and Path(filename).resolve(strict=True) == MANIFEST and re.fullmatch(r"[0-9a-f]{64}", expected),
            "NATIVE_WORKBENCH_SOURCE_BINDING_INVALID")
    raw = MANIFEST.read_bytes()
    require(sha(raw) == expected, "NATIVE_WORKBENCH_SOURCE_MANIFEST_CHANGED")
    manifest = json.loads(raw)
    require(manifest.get("contract") == "ontoweave-workbench-source-lock/1"
            and manifest.get("baseline_id") == baseline and isinstance(manifest.get("files"), list),
            "NATIVE_WORKBENCH_SOURCE_MANIFEST_INVALID")
    paths = set()
    for entry in manifest["files"]:
        path = entry["path"]
        relative = Path(path)
        require(not relative.is_absolute() and ".." not in relative.parts and path not in paths,
                "NATIVE_WORKBENCH_SOURCE_PATH_INVALID")
        paths.add(path)
        file = ROOT / relative
        require(file.resolve(strict=True).is_relative_to(ROOT) and sha(file.read_bytes()) == entry["sha256"],
                "NATIVE_WORKBENCH_SOURCE_CHANGED:" + path)
    verify_skill()
    return dict(files=len(paths), manifest_sha256=sha(dump(manifest)), baseline_id=baseline,
                manifest_path=str(MANIFEST), manifest_bytes_sha256=expected)
