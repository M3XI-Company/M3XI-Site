"""Generate the world that both test suites use.

The hand-off crosses a language boundary: Python assembles a WorldDocument and
splits it into sections, TypeScript writes those sections into rows and renders
a document back out. The only honest way to test that round trip is for both
sides to work from the SAME world, so this writes one out.

    python3 -m tests.make_handoff_fixture        (from spatial/pipeline)

`tests/test_handoff.py` asserts the checked-in file still matches what the
pipeline emits today, so the fixture cannot quietly drift away from the code it
came from; the TypeScript suite replays `sections` through `wv-jobs` and
compares the rendered document against `document`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from worldengine import handoff as H
from worldengine.document import build_and_validate

from tests.fixtures import artefacts

WORLD_ID = "55555555-5555-4555-8555-555555555555"
PROPERTY_ID = "33333333-3333-4333-8333-333333333333"
LABEL = "Flat 2, Alpha Court"

# `createdAt` is the wall clock at assembly. It is pinned here so the fixture
# is a function of the pipeline and nothing else; the comparison at commit
# ignores it for the same reason.
FROZEN_CREATED_AT = "2026-09-19T12:00:00Z"

FIXTURE_PATH = Path(__file__).resolve().parent / "data" / "handoff_fixture.json"

# The packaged assets as `upload_assets` returns them: world-relative object
# names (content checksums), which the edge function prefixes with the world id.
ASSET_ROWS: list[dict[str, Any]] = [
    {"name": "ab/aaaa.spz", "role": "splat", "format": "spz",
     "bytes": 24_000_000, "checksum": "a" * 64, "lod": None, "chunkKey": None,
     "splatCount": 800_000, "meta": {}},
    {"name": "bc/bbbb.spz", "role": "splat_chunk", "format": "spz",
     "bytes": 300_000, "checksum": "b" * 64, "lod": 0, "chunkKey": "_shell",
     "splatCount": 8_000, "meta": {}},
    {"name": "cd/cccc.ply", "role": "proxy_mesh", "format": "ply",
     "bytes": 4_000_000, "checksum": "c" * 64, "lod": None, "chunkKey": None,
     "splatCount": None, "meta": {}},
    # The build artefact. Registered so an operator can find the document a
    # build produced, and excluded from the world by its reserved chunk key.
    {"name": H.RAW_DOCUMENT_OBJECT_NAME, "role": "export_bundle", "format": "json",
     "bytes": 90_000, "checksum": "d" * 64, "lod": None,
     "chunkKey": H.RAW_DOCUMENT_CHUNK_KEY, "splatCount": None,
     "meta": {"purpose": "the document this build assembled, kept for diffing "
                         "against the rows"}},
]

ASSET_URLS = {
    "/tmp/world.spz": f"asset://{WORLD_ID}/{WORLD_ID}/ab/aaaa.spz",
    "/tmp/chunks/_shell.spz": f"asset://{WORLD_ID}/{WORLD_ID}/bc/bbbb.spz",
    "/tmp/proxy.ply": f"asset://{WORLD_ID}/{WORLD_ID}/cd/cccc.ply",
}


def build() -> dict[str, Any]:
    document = build_and_validate(
        world_id=WORLD_ID, property_id=PROPERTY_ID, version=1, label=LABEL,
        artefacts=artefacts(), asset_urls=ASSET_URLS, slug="flat-2-alpha-court")
    document["createdAt"] = FROZEN_CREATED_AT
    return {
        "worldId": WORLD_ID,
        "propertyId": PROPERTY_ID,
        "version": 1,
        "label": LABEL,
        "assets": ASSET_ROWS,
        "document": document,
        "sections": list(H.sections(document, ASSET_ROWS)),
    }


def main() -> int:
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(build(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {FIXTURE_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
