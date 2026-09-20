"""Document assembly and contract validation."""
from __future__ import annotations

import copy
import math

import pytest

from worldengine import contract as C
from worldengine.document import assemble, build_and_validate
from worldengine.geometry import is_ccw_from_above
from tests.fixtures import artefacts


def build(**over):
    return build_and_validate(world_id="wld_1", property_id="prp_1", version=1,
                              label="Flat 3, 12 Example Road",
                              artefacts=artefacts(**over))


def test_document_validates_and_carries_the_frame_conventions():
    doc = build()
    assert doc["formatVersion"] == 1
    assert doc["units"] == {"length": "m", "angle": "rad"}
    assert doc["upAxis"] == "Y" and doc["handedness"] == "right"
    assert C.validate(doc) == []


def test_every_room_polygon_is_ccw_from_above_and_areas_match():
    doc = build()
    assert len(doc["rooms"]) == 2
    for r in doc["rooms"]:
        assert is_ccw_from_above(r["polygon"])
    areas = sorted(r["area"]["value"] for r in doc["rooms"])
    assert math.isclose(areas[0], 9.0, abs_tol=1e-6)
    assert math.isclose(areas[1], 12.0, abs_tol=1e-6)


def test_every_area_declares_a_standard_and_a_tolerance():
    doc = build()
    for r in doc["rooms"]:
        q = r["area"]
        assert q["standard"] == "RICS-COMP-GIA"
        assert q["tolerance"] == 5.0 and q["toleranceUnit"] == "pct"
        assert q["basis"]["scaleSource"]


def test_quantity_without_a_standard_is_rejected():
    doc = build()
    bad = copy.deepcopy(doc)
    del bad["rooms"][0]["area"]["standard"]
    errs = C.validate(bad)
    assert any("undeclared measurement standard" in e for e in errs)


def test_area_provenance_is_the_weaker_of_polygon_and_scale():
    """A perfectly reconstructed polygon measured with an inferred metre gives
    an inferred area. This is the rule the whole product rests on."""
    doc = build()
    room = doc["rooms"][0]
    assert room["grounding"]["provenance"] == "reconstructed"
    assert room["area"]["grounding"]["provenance"] == "inferred"
    assert room["area"]["grounding"]["confidence"] <= room["grounding"]["confidence"]


def test_low_scale_confidence_propagates_into_every_area():
    doc = build(scale={"confidence": 0.25, "agreement": 0.3,
                       "source": "moge2:estimators-disagree"})
    for r in doc["rooms"]:
        assert r["area"]["grounding"]["confidence"] <= 0.25
    assert doc["scale"]["agreement"] == 0.3


def test_room_kind_comes_from_semantics_when_geometry_cannot_tell():
    doc = build()
    kinds = {r["id"]: r["kind"] for r in doc["rooms"]}
    assert kinds["rm_000"] == "living"     # a sofa was seen in it
    assert kinds["rm_001"] == "bedroom"    # a bed was seen in it


def test_entity_without_surviving_observations_drops_to_generated():
    a = artefacts()
    a["semantics"]["entities"][0]["observed_in"] = ["nope_not_a_camera"]
    doc = build_and_validate(world_id="w", property_id="p", version=1,
                             label="x", artefacts=a)
    ent = next(e for e in doc["entities"] if e["id"] == "ent_0000")
    assert ent["observedIn"] == []
    assert ent["grounding"]["provenance"] == "generated"
    assert C.validate(doc) == []


def test_contract_rejects_an_observed_entity_with_no_cameras():
    doc = build()
    bad = copy.deepcopy(doc)
    bad["entities"][0]["observedIn"] = []
    bad["entities"][0]["grounding"]["provenance"] = "observed"
    errs = C.validate(bad)
    assert any("no observedIn cameras" in e for e in errs)


def test_regions_carry_unobserved_volumes_and_never_say_reconstructed():
    doc = build()
    provs = {r["provenance"] for r in doc["regions"]}
    assert "inferred" in provs
    assert "reconstructed" not in provs
    bad = copy.deepcopy(doc)
    bad["regions"][0]["provenance"] = "reconstructed"
    assert any("regions[0].provenance" in e for e in C.validate(bad))


def test_surface_flags_survive_into_the_document():
    doc = build()
    glazed = [s for s in doc["surfaces"] if s["isGlazed"]]
    assert len(glazed) == 1
    assert all(isinstance(s["isReflective"], bool) for s in doc["surfaces"])


def test_nav_edges_referencing_missing_nodes_are_dropped_not_emitted():
    a = artefacts()
    a["graph"]["nav_edges"].append({"a": "nav_00000", "b": "nav_missing",
                                    "cost": 1.0, "width": None, "kind": "walk",
                                    "opening_id": None})
    doc = build_and_validate(world_id="w", property_id="p", version=1,
                             label="x", artefacts=a)
    assert len(doc["nav"]["edges"]) == 1
    assert C.validate(doc) == []


def test_dangling_references_are_caught_by_the_validator():
    doc = build()
    bad = copy.deepcopy(doc)
    bad["openings"][0]["roomA"] = "rm_nope"
    assert any("roomA" in e and "dangling" in e for e in C.validate(bad))


def test_quaternion_must_be_unit():
    doc = build()
    bad = copy.deepcopy(doc)
    bad["cameras"][0]["orientation"] = [0.0, 0.0, 0.0, 2.0]
    assert any("must be unit" in e for e in C.validate(bad))


def test_clockwise_polygon_is_rejected_rather_than_silently_flipped():
    doc = build()
    bad = copy.deepcopy(doc)
    bad["rooms"][0]["polygon"] = list(reversed(bad["rooms"][0]["polygon"]))
    assert any("counter-clockwise" in e for e in C.validate(bad))


def test_tiny_room_is_rejected():
    doc = build()
    bad = copy.deepcopy(doc)
    bad["rooms"][0]["polygon"] = [[0, 0], [0, 0.4], [0.4, 0.4], [0.4, 0]]
    assert any("below the 0.25 m2 floor" in e for e in C.validate(bad))


def test_build_and_validate_raises_on_a_broken_world():
    a = artefacts()
    a["layout"]["rooms"][0]["ceiling_z"] = -1.0     # ceiling below the floor
    with pytest.raises(C.ContractError, match="ceilingZ must be above floorZ"):
        build_and_validate(world_id="w", property_id="p", version=1,
                           label="x", artefacts=a)


def test_assets_get_urls_when_uploaded_and_file_refs_when_not():
    a = artefacts()
    doc = build_and_validate(world_id="w", property_id="p", version=1, label="x",
                             artefacts=a,
                             asset_urls={"/tmp/world.spz": "https://cdn/x.spz"})
    urls = {x["role"]: x["url"] for x in doc["assets"]}
    assert urls["splat"] == "https://cdn/x.spz"
    assert urls["proxy_mesh"].startswith("file://")


def test_weakest_provenance_ordering():
    assert C.weakest_provenance("observed", "inferred") == "inferred"
    assert C.weakest_provenance("reconstructed", "generated") == "generated"
    assert C.weakest_provenance("observed") == "observed"
    with pytest.raises(ValueError):
        C.weakest_provenance("made-up")


def test_validator_survives_garbage_without_raising():
    assert C.validate({}) != []
    assert C.validate([]) == ["document is not an object"]
    assert C.validate({"formatVersion": 1}) != []


def test_a_relationship_whose_endpoint_did_not_survive_assembly_is_dropped():
    """The graph stage cannot know what assembly will discard.

    A surface with a degenerate polygon never reaches the document, and an
    edge pointing at one describes a thing that is not there: the viewer cannot
    draw it and the ingest cannot resolve it. Dropping it here is what keeps
    the document internally closed.
    """
    a = artefacts()
    a["graph"]["relationships"] = list(a["graph"]["relationships"]) + [
        {"subject_type": "surface", "subject_id": "srf_missing",
         "predicate": "inside", "object_type": "room", "object_id": "rm_000",
         "value": None, "provenance": "reconstructed", "confidence": 0.6},
        {"subject_type": "room", "subject_id": "rm_000", "predicate": "contains",
         "object_type": "entity", "object_id": "ent_missing",
         "value": None, "provenance": "inferred", "confidence": 0.6},
    ]
    doc = build_and_validate(world_id="w", property_id="p", version=1, label="x",
                             artefacts=a)
    ids = {(r["subjectType"], r["subjectId"]) for r in doc["relationships"]}
    ids |= {(r["objectType"], r["objectId"]) for r in doc["relationships"]}
    assert ("surface", "srf_missing") not in ids
    assert ("entity", "ent_missing") not in ids
    # The real ones survive.
    assert ("room", "rm_000") in ids


def test_a_nav_edge_citing_an_opening_that_is_not_in_the_document_loses_the_citation():
    """The edge is still walkable; it just no longer claims a doorway that is
    not there."""
    a = artefacts()
    a["graph"]["nav_edges"][0]["opening_id"] = "opn_missing"
    doc = build_and_validate(world_id="w", property_id="p", version=1, label="x",
                             artefacts=a)
    edge = doc["nav"]["edges"][0]
    assert "openingId" not in edge
    assert edge["cost"] > 0
