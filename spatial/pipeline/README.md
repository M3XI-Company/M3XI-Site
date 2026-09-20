# worldengine

The M3XI World Viewer reconstruction pipeline. Takes a phone walkthrough video
of a UK property and writes a world into the database, in the shape
`spatial/packages/world-core/src/types.ts` defines: metres, radians,
right-handed, +Y up, quaternions `[x, y, z, w]`, room footprints as XZ rings
wound counter-clockwise viewed from above.

**The database is the world.** The pipeline assembles a `WorldDocument` because
that is what every package compiles against, and it uploads that document as
`build/world.raw.json` — but as a build artefact, for diffing. What a viewer
loads is rendered from the rows. See [The hand-off](#the-hand-off).

```
worldengine plan                              # the DAG, the artefacts, the budget
worldengine doctor                            # what is installed, what is missing
worldengine run --run-dir ./run --source walk.mp4 --dry-run
worldengine run --run-dir ./run --source walk.mp4 --world-id <uuid>
worldengine stage redact --run-dir ./run --force
worldengine document --run-dir ./run --world-id <uuid> --property-id <uuid>
                                              # -> build/world.raw.json
python -m worldengine.worker --poll 10 --idle-exit 300   # RunPod entry point
```

---

## The DAG

```
ingest ─▶ frames ─▶ redact ─▶ pose ─▶ scale ─▶ splat ─┬─▶ mesh ─▶ layout ─┬─▶ semantics
                                                      │                    │
                                                      └────────────────────┴─▶ graph ─▶ regions
                                                                                         │
                          package ◀── splat, mesh, layout, regions ─────────────────────┘
                          quality ◀── package, graph, scale, redact, frames
```

`redact` sits between `frames` and everything that touches pixels, and that is
structural, not conventional. `pose`, `scale`, `splat`, `mesh` and `semantics`
read their frame list from **redact's** output; they have no path to the raw
frames. `runner.validate_privacy_ordering()` asserts the reachability property
at the start of every run and `DagRunner.__init__` refuses to construct a graph
that violates it, so PII cannot enter a splat by accident or by an edit to the
graph. `tests/test_runner.py` fails if someone rewires it.

| Stage | What it does | Model / tool | Licence |
|---|---|---|---|
| `ingest` | ffprobe, honour rotation metadata, strip audio, reject captures that cannot work (< 45 s, short edge < 1080 px) | ffmpeg | LGPL (invoked as a binary, not linked) |
| `frames` | decode at 7.5 fps candidates, score blur and motion, select 200–400 at 60–80% overlap | own: variance of Laplacian + Lucas-Kanade | — |
| `redact` | detect and destroy faces, documents, correspondence, screens, framed photos, medication, number plates, people through windows | YuNet (MIT) · OWLv2 (Apache-2.0) · docTR db_resnet50 (Apache-2.0) · SAM 3.1 masks | see below |
| `pose` | feed-forward poses + metric depth, then bundle adjustment on real correspondences | MapAnything `facebook/map-anything-apache` → COLMAP 4.0 with ALIKED + LightGlue | Apache-2.0 / BSD |
| `scale` | second, independent metric estimate; agreement sets the confidence of every dimension | MoGe-2 `Ruicheng/moge-2-vitl-normal` | MIT |
| `splat` | MCMC densification, bilateral grid for auto-exposure, depth prior, identity head | gsplat | Apache-2.0 |
| `mesh` | TSDF fusion of rendered depth + normals, RANSAC plane extraction, mirror/glazing flags | DN-Splatter `gs-mesh o3dtsdf` (Open3D fallback in-process) | Apache-2.0 / MIT |
| `layout` | room polygons from a top-down density map, doorways from geometry | RoomFormer | MIT |
| `semantics` | text-prompt concepts tracked through the video, lifted onto the gaussians | SAM 3.1 + Gaussian-Grouping-style identity head on gsplat | SAM licence / Apache-2.0 |
| `graph` | scene graph and navigation mesh, from geometry only | none — no model is consulted | — |
| `regions` | visibility carve; emit unobserved and generated volumes explicitly | own: voxel + depth occlusion test | — |
| `package` | SPZ primary, SOG where supported, PLY archived, chunked by room | in-tree SPZ codec, `splat-transform` for SOG | MIT / open |
| `quality` | twelve checks, thresholds with written justifications, pass / review / fail | — | — |

Each stage module exposes `SUMMARY`, `USES_GPU`, `PRODUCES`, a typed `Input`
and `Output` dataclass, `build_input(ctx, upstream)` and `run(inp, ctx)`. That
is what makes them independently runnable (`worldengine stage <name>`) and
independently testable.

---

## The hand-off

The last thing a job does is not write a file. It hands the world to the system
of record, and the system of record is the database.

That is a decision with a reason, and the reason is operator correction. An
operator renames a room, moves a misplaced object, fixes a dimension, approves
a redaction. Those writes have to land in rows — rows that `..._rls.sql`
protects per tenant, that a portfolio query can read across, that per-room
analytics and measurement records can point at, and that a rescan can carry a
`stable_key` forward into. If the uploaded file were authoritative, every one of
those corrections would be a patch applied to a blob, and the row-level policies
that make a correction safe would stop meaning anything.

So `world.json` is a **derived artefact**, regenerated from the rows, and the
document this pipeline assembles is a **build artefact** named
`build/world.raw.json` so that nobody mistakes it for the world.

```
run the DAG ─▶ upload assets ─▶ assemble + validate (document.py)
                                        │
                                        ├─▶ build/world.raw.json   (the build)
                                        │
                                        └─▶ ingest-world           (the world)
                                              header, floors, rooms, surfaces,
                                              openings, cameras, entities,
                                              nav-nodes, nav-edges, regions,
                                              relationships, assets, quality
                                                     │
                                                     └─▶ commit
                                                         render rows -> document
                                                         diff against the build
                                                         publish, cache
```

**Validation stays where it was.** `document.py` refuses to emit a document
that does not satisfy the contract, and it has no non-strict mode. Nothing
malformed reaches the tables, because nothing malformed leaves the process that
built it — and the edge function validates every row again on arrival anyway,
because the pipeline is not the only thing that could ever call it.

**Sections, because the document does not fit.** The request cap is 256 KB. A
two-bed flat's document is about 100 KB, which is exactly the number that makes
chunking look unnecessary; a five-bed house with a full semantic pass is several
times that. So it is never sent whole. `handoff.py` splits each section by row
count *and* by serialised size — a single wall can carry a 400-vertex outline
and fifty nav nodes together do not — and a row too large to fit in a request
fails loudly at the start of the hand-off rather than as an HTTP 400 twenty-five
minutes into a GPU job.

**Re-sending is safe, because nothing is keyed by the attempt.** A preempted pod
has its lease reclaimed and its job re-run, and the re-run sends everything
again. Rooms and entities are keyed by `(world_id, stable_key)` — expressed as a
primary key derived from the stable key, so that references to them are stable
too, and so a rescan lands on the room it supersedes. Everything else is keyed
by the pipeline's own local id (`srf_000`, a frame id, `nav_00017`), which is
already stable across a re-run. Relationships and nav edges have no natural id
and a `bigserial` primary key, so they upsert against a unique index over their
endpoints. Chunks within a section may arrive in any order.

**References travel as keys, not as ids.** A surface names its room by the
room's `stableKey`, never by `rm_000`, because `rm_000` is a label this build
chose and the row's identity is not. Everything else travels as its local id.
The edge function checks each reference against the rows that are actually
there and refuses a section that arrived before the one it depends on, naming
that section — a retry the worker can act on, rather than a foreign-key
violation it cannot read.

**The commit is the proof.** The edge function downloads `build/world.raw.json`,
renders the world back out of the rows, and compares them. Ordering and
identifiers are cosmetic — the comparison rewrites database uuids back through
the deterministic id map, so a mis-keyed row shows up as a *missing* one rather
than slipping past as a rename — and so are timestamps, the slug, the label and
the last digit of every number (each tolerance is set from its column's declared
scale). A missing room, a dropped surface, a changed measurement, a nav edge
that did not survive: those are material, and they refuse the commit. The world
does not publish, no document is cached, and the job fails **without a retry**,
because the run resumes from the same checkpoints and would build the same
document three times before anyone heard about it.

Two things the rendered document is knowingly poorer at than the assembled one,
stated rather than glossed: `grounding.sources` (which cameras established a
room) and `Quantity.basis` (the geometry that produced an area) have no column
in the schema, so they live in the build artefact only. The comparison does not
check them, and that omission is a decision rather than an oversight.

---

## GPU, VRAM, time and cost

Per stage, for the reference job: a 2-bed UK flat, ~4 minutes of 1080p60 phone
video, ~300 selected frames at 1600×900, single NVIDIA L40S (48 GB, Ada).

| Stage | GPU-held | Pod wall | Peak VRAM | Where the number comes from |
|---|---:|---:|---:|---|
| ingest | 0 s | 20 s | — | ffprobe plus a stream copy of a ~500 MB file |
| frames | 0 s | 165 s | — | full decode of ~7 200 frames, Laplacian + LK on ~1 800 candidates at 960 px (~15 ms/pair) |
| redact | 240 s | 250 s | ~8 GB | 300 frames × (OWLv2 ~90 ms + docTR ~40 ms + SAM 3.1 ~120 ms on frames with hits + YuNet on CPU) |
| pose | 300 s | 310 s | **~28 GB** | MapAnything: 12 chunks of 32 views at 518², ~10 s each. ALIKED 300×25 ms, LightGlue ~3 600 pairs × 20 ms, COLMAP triangulator + BA ~100 s (CPU-bound) |
| scale | 90 s | 95 s | ~8 GB | MoGe-2 ViT-L, 60 frames × ~0.5 s, plus model load |
| splat | 900 s | 905 s | ~14 GB | 30 000 iterations at ~34 it/s with MCMC, bilateral grid and SSIM; plus 2.6 GB of fp16 training images held resident |
| mesh | 150 s | 155 s | ~6 GB | 300 depth+normal renders (~30 ms each) then Open3D TSDF at 2 cm, which is CPU |
| layout | 30 s | 35 s | ~2 GB | one RoomFormer forward on a 256² map; dominated by model load |
| semantics | 330 s | 335 s | ~16 GB | SAM 3.1 image encoding 300×60 ms once, then 36 concept propagations, then the identity lift |
| graph | 0 s | 25 s | — | ~1 100 nav nodes, O(n²) within each room |
| regions | 0 s | 70 s | — | 54 k voxels × 300 cameras in numpy (seconds); dominated by reading 300 depth archives |
| package | 0 s | 60 s | — | SPZ encode + gzip of ~1 M gaussians, chunking, LOD |
| quality | 0 s | 5 s | — | arithmetic |
| **total** | **34.0 min** | **40.5 min** | **~28 GB** | |

**Cost.** Two numbers, and the difference is real money.

|  | GPU-held 34.0 min | Pod wall 40.5 min |
|---|---:|---:|
| on-demand L40S @ $1.10/GPU-hr | $0.62 | **$0.74** |
| serverless L40S @ $1.75/GPU-hr | $0.99 | **$1.18** |

The brief's target was ~35 GPU-minutes and ~$0.64 on-demand. The GPU-held
figure lands at 34 minutes and $0.62, inside that. But **RunPod bills a
dedicated pod for its whole lifetime, not for GPU utilisation**, and four
stages here are CPU-only, so the number on the invoice is the wall figure:
about $0.74 on-demand. Quoting only the GPU figure would understate the real
unit cost by roughly 18%, which at 5 000 worlds a month is £700. `worldengine
plan` prints both, and `CostLedger` measures both at run time and writes them
to `run.json`.

Rates are configuration, not physics — set `WORLDENGINE_USD_PER_GPU_HOUR` or
`WORLDENGINE_BILLING_MODE`. RunPod's serverless *flex* rate is roughly twice
the active-worker rate used above; if you run flex, change the env var, do not
change the story.

**The two levers that matter.** `splat` is 44% of the GPU bill. `--splat-fast`
halves it to 15 000 iterations, which costs about 0.4 dB PSNR — worth taking on
a routine listing and not on a flagship. `semantics` is the next largest and
scales linearly with the concept list: cutting `CONCEPTS` from 36 to the 12
things buyers actually ask about would save ~3 GPU-minutes.

**VRAM headroom.** The binding constraint is `pose` at ~28 GB, driven by
MapAnything's attention over a 32-view chunk. On a 24 GB card (L4, A10G, 4090)
set `--params '{"pose_chunk": 16}'`; global consistency degrades slightly and
COLMAP recovers most of it. Every GPU stage preflights its own minimum with
`require_cuda(min_vram_gb=...)` and raises `StageUnavailable` rather than
OOM-ing at minute 25.

---

## What is verified here, and what is not

This package was written and tested on a CPU machine with no GPU and no model
weights. That distinction is stated precisely rather than glossed.

### Verified — 265 passing tests, run on this machine

```
tests/test_geometry.py           15  coordinate frames, quaternions, rings
tests/test_frames.py             17  blur scoring and frame selection
tests/test_runner.py             27  DAG, privacy ordering, resume, cost ledger
tests/test_document.py           22  assembly, contract validation, closure
tests/test_quality.py            14  the gate's scoring and verdicts
tests/test_formats.py            27  PLY and SPZ headers and round-trips
tests/test_regions.py            11  the visibility carve
tests/test_redact.py             16  redaction planning and pixel destruction
tests/test_scale.py              13  metric cross-check statistics
tests/test_graph_and_layout.py   35  scene graph, nav, planes, packaging
tests/test_handoff.py            16  sections, chunking, re-sending, references
tests/test_worker.py             36  wv-jobs transport, auth, leases, uploads
tests/test_integration.py        16  plan, dry run, fail-loud, CLI
                                ---
                                265  passed in ~7 s
```

The other half of the hand-off is tested on the TypeScript side, against the
same world: `tests/data/handoff_fixture.json` is generated by this pipeline
(`python3 -m tests.make_handoff_fixture`), `tests/test_handoff.py` fails if it
drifts from what the pipeline emits, and
`spatial/packages/agent/src/__tests__/ingest.test.ts` replays its sections
through `wv-jobs` and asserts the document rendered back out of the rows is the
same world.

Specific things these actually prove, rather than exercise:

- **Blur rejection separates real blur from low contrast.** A box-blurred
  synthetic frame scores >20× lower than its sharp original, and the
  contrast-normalised score of a frame dimmed to 25% differs from the bright
  original by under 5% while the raw variance-of-Laplacian differs by 90%. That
  is the property that lets one threshold work in a dark hallway and a bright
  bay window.
- **The ring winding convention is derived, not guessed.** The test contains
  the derivation: viewed from +Y looking down with +X right, screen-up is −Z,
  so counter-clockwise on screen is a *negative* shoelace in (x, z).
- **An identity OpenCV extrinsic is upside down in a +Y-up world**, and the
  conversion says so. This is the test that catches an inverted world.
- **Resume works.** A run that fails at the last stage re-runs exactly that
  stage on the next attempt; a changed parameter invalidates the whole chain; a
  stage that re-runs and produces byte-identical output leaves its dependents
  cached.
- **A world can be handed over twice without doubling.** The full section
  stream is replayed against a fresh database and then replayed again; every
  table holds exactly the same number of rows after the second pass, and the
  document rendered from them is unchanged. An operator's rename survives the
  second pass, because a section that carries no name does not write the
  column.
- **A world that does not match what was built does not publish.** Drop one
  room row between the sections and the commit, and the commit refuses with
  `missing rooms`, the world stays unpublished and no document is cached.
- **Missing models fail loudly.** Every GPU stage raises `StageUnavailable`
  with an actionable message on this machine, and the runner turns that into a
  failed run with no artefact written.
- **SPZ round-trips** within its quantisation bounds (positions to 0.24 mm at
  12 fractional bits, ~7× smaller than float32 PLY), rejects bad magic, bad
  version and truncation, and encodes deterministically.
- **The gate blocks publication.** One unapplied redaction or scale agreement
  below 0.90 fails outright regardless of every other score.

### Not verified, and exactly what would verify it

| Unverified | Why | What would settle it |
|---|---|---|
| MapAnything's `infer()` signature and output keys (`pts3d`, `depth_z`, `camera_poses`, `intrinsics`, `metric_scaling_factor`, `conf`) | no weights, no GPU | one forward pass on 8 frames on an L40S; a mismatch is a 10-line fix in `run_mapanything` |
| **SAM 3.1's Python API** — `SAM3VideoPredictor`, `add_text_prompt`, `propagate_in_video`, and the image-predictor used by `redact` | this is the single most likely binding to need adjustment, and it is used by two stages | load the checkpoint and run one concept over 10 frames |
| MoGe-2's `infer()` returning `depth`/`mask` at input resolution | no weights | one forward pass; the cross-check maths above it is fully tested |
| gsplat's `MCMCStrategy` call signature and the N-D rasterisation path used by the identity head | no GPU | 100 training iterations on 20 frames |
| RoomFormer's `build_model(args)` and output decoding | research repo, vendored | one forward pass on a synthetic density map |
| COLMAP 4.0 `point_triangulator` accepting a MapAnything prior model | needs the built binary | one run on 30 frames; check `registered_fraction` |
| **SPZ against the reference decoder** | needs network access to SuperSplat / libspz | open one produced file in PlayCanvas SuperSplat. Until then, treat SPZ as unproven for third-party consumption and ship the PLY alongside |
| Every number in the cost table | no GPU | one full run with `run.json`'s measured ledger compared against `costs.ESTIMATED_*` |
| Redaction recall on real UK interiors | no labelled set | 50 hand-labelled frames from real tours, measured per class; see below |

---

## Redaction

Runs before pose, splat and semantics. Blurring a published splat afterwards
does not work: gaussians are a 3D representation, and a face baked into them is
recoverable from a viewpoint the 2D blur never considered.

Why the stage exists, concretely: a published UK property tour exposed a
dividend cheque, an insurance policy, a stairlift invoice and an inhaler — four
separate disclosures about one household's finances and health, from one video.
A study of 44 US virtual tours found names, medication labels and card details
across them. Neither required an attacker; both required a buyer with a pause
button.

**Detectors, and why these ones.**

- **Faces — YuNet** (`cv2.FaceDetectorYN`, MIT, opencv_zoo). The obvious choice
  would be SCRFD or RetinaFace from InsightFace; the InsightFace model zoo is
  **non-commercial**, so it is unusable here.
- **Documents and correspondence — docTR `db_resnet50`** (Apache-2.0), run as a
  *density* detector. Word boxes are clustered by a gap threshold of 1.2 line
  heights; a cluster of ≥6 words covering ≥2% of its box is a document. The
  pipeline never reads the text — OCRing a stranger's correspondence to decide
  whether to remove it would be the same privacy violation we are here to
  prevent.
- **Screens, framed photographs, medication, number plates, people —
  OWLv2** `google/owlv2-base-patch16-ensemble` (Apache-2.0), open-vocabulary,
  prompted with noun phrases. Deliberately **not YOLO-World, which is GPL-3.0**
  and would contaminate the product.
- **Mask refinement — SAM 3.1**, prompted with those boxes, so the fill follows
  the object rather than a rectangle. Optional; without it, dilated boxes are
  used and the stage records that it over-redacted.

Per-class thresholds are asymmetric on purpose: medication sits at 0.10 and
screens at 0.18, because missing a medication box is a privacy failure and
over-redacting a television is cosmetic.

**Removal is destructive, not generative.** Faces, documents, correspondence,
medication, plates and screens are Telea-inpainted and then heavily blurred, so
no high-frequency content survives and nothing is invented. Framed photographs
— furniture as much as PII — are inpainted only. Every mask is dilated by 8% of
its short side (PII leaks at the edges) and the result is feathered, because a
hard rectangle edge is exactly the structure a splat trainer reconstructs as a
floating slab. `tests/test_redact.py` measures that the Laplacian variance
inside a redacted region drops below 2% of the original while pixels outside
the feather band are bit-identical.

**A licence trap worth naming.** LaMa is the obvious high-quality inpainter and
its *code* is Apache-2.0 — but the `big-lama` **weights are CC BY-NC-SA 4.0**,
which is non-commercial. It is not wired in. `redact_image` raises with that
explanation if anyone asks for it.

Every detection is written to `redactions.json` and inserted into `wv_redaction`
with its bbox, detector, score and applied flag, whether or not it was applied.
"Did you look for medication packaging in this tour" has a row-level answer.

---

## Metric scale

MapAnything and MoGe-2 both emit metric depth from monocular input, trained on
different data with different architectures. Their agreement is the confidence
signal.

Per frame: robust median of `log(moge_depth / mapanything_depth)` over pixels
that are co-valid, unsaturated and in range — log space because scale error is
multiplicative and 10% high must be symmetric with 10% low. Across frames: the
median is the correction and the MAD-based spread is the warning.

| Disagreement | Verdict | Confidence | Behaviour |
|---|---|---|---|
| ≤ 3% | agreed | 0.80–0.95 | correct by the measured residual |
| 3–8% | review | 0.40–0.65 | **adopt MoGe-2 outright**, flag the world |
| > 8% | not quotable | 0.25 | adopt MoGe-2, flag, quality gate fails |

**They are never averaged.** Averaging two estimates 12% apart yields a number
wrong by 6% carrying no signal that anything went wrong. MoGe-2 is preferred on
stated grounds: MapAnything's metric head aggregates across views, so a short
baseline or a dominant mirror can drag the whole reconstruction's scale — which
is precisely the situation in which the two disagree. That is a defensible
default, not a proof, which is why the flag exists.

**The tolerances reflect measured reality.** Indoor monocular metric depth is
realistically 2–5%. That is why `DEFAULT_MEASUREMENT_POLICY` publishes **5% on
areas and 50 mm on walls** rather than something tighter that would look
better. `tests/test_scale.py` asserts the published tolerance is no tighter
than the agreement band the pipeline can certify, and that the gate's 0.90
threshold corresponds exactly to the 3% band — if those drift apart the gate
stops meaning what it says.

A wide per-frame spread with a tight centre is called out separately: the
estimators agreeing on average while disagreeing frame to frame is the
signature of a mirror in part of the capture.

---

## Mirrors and glazing — how well this actually works

A mirror is a window onto a room that does not exist. Both depth estimators see
through it, COLMAP triangulates the reflected features, and a two-bed flat
grows a third bedroom nobody can find. Glazing fails the other way: the
exterior clips, depth goes unconstrained, and floaters bloom outside every
window.

Four signals, combined per surface (`worldengine/reflective.py`), with mirror
and window detection kept as **separate** terms — a single shared "something
was detected" score makes every mirror also read as glazed, and the viewer then
treats it as somewhere daylight comes from:

| Signal | Weight (reflective) | Character |
|---|---:|---|
| depth behind the local wall plane | 0.45 | close to a physical test; needs no model |
| mirror detection (OWLv2) | 0.25 | reliable for a large framed mirror |
| view-dependence of photometric residual | 0.20 | needs a trained splat, so only from `mesh` onward |
| saturation | — (0.50 for glazed) | separates a window from a wall |

**Honestly: the geometric signals work, the detection does not carry it.**
Depth-behind-plane separates a mirror from flat wall decor cleanly when the
mirror is larger than roughly 0.5 m and the camera passes it obliquely, which a
walkthrough normally does — `tests/test_graph_and_layout.py` demonstrates the
separation on synthetic geometry (>0.95 behind for a mirror, <0.05 for a
picture). The cases it does not catch: a mirror seen only head-on (the
reflection's geometry degenerates to a plane and reads as a picture), a small
bathroom mirror above a basin seen from one position, and two mirrors facing
each other. There is **no calibrated precision/recall number here**, because
measuring one needs a labelled set of UK interiors this pipeline does not have.

What matters is what happens under uncertainty: a flagged surface *downgrades
the confidence* of everything derived from it rather than being deleted, the
scale stage excludes saturated pixels before comparing estimators, and the
`mesh` stage warns when more than 2 m² is flagged. A flat full of mirrors
routes to an operator instead of publishing.

---

## Provenance

`observed` a camera saw it · `reconstructed` geometry derived it · `inferred` a
model estimated it · `generated` a model invented it. They never collapse.

The rule that bites: a room polygon is `reconstructed`, but its **area** is
only as good as the metric scale, which is `inferred` — so the area `Quantity`
carries `weakestProvenance(polygon, scale)` and the lower of the two
confidences. The same applies to every derived number. A semantic entity is
`inferred` even at high confidence, and drops to `generated` if none of its
observing cameras survived into the document.

The `regions` stage computes what the cameras never saw: a 15 cm voxel grid over
the reconstructed volume, with a voxel counted `observed` only when at least
**two** cameras have it inside their frustum *and* their measured depth puts the
nearest surface at or behind it. Everything else inside the building envelope is
emitted as an explicit `inferred` Region; a room RoomFormer closed with no
camera ever inside it is emitted as a whole-room **`generated`** Region, so the
viewer can grey it out and the agent can refuse to answer inside it. A room the
capture never entered does not quietly appear as a real room.

`regions.run()` refuses to proceed without depth maps rather than falling back
to frustum-only carving, because frustum membership alone would claim every
voxel in view was observed — exactly the lie the stage exists to prevent.

---

## The quality gate

Twelve checks. Weights sum to exactly 1.0 (enforced by test). Every threshold
carries its justification in `stages/quality.py` and the test suite fails if
any justification is shorter than 80 characters.

| Check | Threshold | Hard | Weight |
|---|---|:-:|---:|
| redaction_completeness | = 1.0 | ● | 0.10 |
| scale_agreement | ≥ 0.90 | ● | 0.14 |
| pose_consistency | ≥ 0.95 | | 0.11 |
| geometry_consistency | ≥ 0.70 | | 0.09 |
| room_completeness | ≥ 0.80 | | 0.09 |
| identity_stability | ≥ 0.70 | | 0.07 |
| navigation_continuity | = 1.0 | | 0.09 |
| floater_rate | ≤ 0.02 | | 0.07 |
| unobserved_fraction | ≤ 0.25 | | 0.08 |
| depth_confidence | ≥ 0.60 | | 0.07 |
| semantic_confidence | ≥ 0.55 | | 0.05 |
| blur_rejection_rate | ≤ 0.30 | | 0.04 |

Any hard check failing, or a score below 0.55 → **fail**. Any other check
failing, or a score below 0.80 → **review**. Otherwise → **pass**.

The two hard gates are the two places where geometric excellence cannot
compensate. `redaction_completeness` is exactly 1.0, not 0.99, because one
unapplied detection is one published face or one published bank letter.
`scale_agreement ≥ 0.90` is the 3% band: below it a 4.00 m wall could be quoted
outside the 5% tolerance the product publishes, and a measurement nobody can
defend is a liability under the DMCC Act 2024, not a soft quality issue.

Normalisation is clipped at 1.0 per check, so exceeding one threshold earns no
credit that offsets failing another. A world that is superb everywhere and
unredacted is not a good world.

`blur_rejection_rate` is a check on the **capture**, not the pipeline: over 30%
and the operator should be told to walk more slowly.

---

## What the pod is trusted with

**One secret: `WV_WORKER_SECRET`.** Plus the `wv-jobs` URL and the pod's own
pre-registered `WV_WORKER_ID`. No Supabase service-role key, no storage
credential, no PostgREST access — and no code path in `worker.py` that could
use one. `tests/test_worker.py` greps the module for `SUPABASE_*`,
`service_role`, `apikey` and `/rest/v1/` and fails if any reappears, because a
fallback that works is a fallback that gets used.

The reason is blast radius. A service-role key does not grant access to the
`wv_` tables; it bypasses RLS across the *entire* project — billing, leads, AI
turns, every other tenant's properties. These GPU boxes are rented by the
minute from a third party, recycled between customers, and their filesystem
and environment are not ours to guarantee. One compromised pod should cost us
one pod.

So everything the worker needs to write goes through an action on `wv-jobs`,
which authenticates the shared secret in constant time, checks that this worker
holds the job's lease, and **reads `world_id` from the claimed job row rather
than from the request body**. A worker that has legitimately leased job X
cannot write assets, redactions or a quality verdict into another tenant's
world by naming it.

| Action | What the worker sends | What the function guarantees |
|---|---|---|
| `claim` | its stages, lease length | one job, `SKIP LOCKED`, only stages this worker is registered for, **plus the world's property id, version, label and slug** — the pod does not get to decide whose property it reconstructed |
| `heartbeat` | job id | only the lease holder may extend; 409 otherwise |
| `upload-urls` | object names | signed PUT URLs, 15-minute expiry, one path each, prefixed with the job's world id |
| `redactions` | detection rows, batched ≤500 | `world_id` taken from the job, kinds and bboxes validated |
| `ingest-world` | the world, in chunked sections | every row re-validated and keyed to the job's world; references checked, not trusted; `commit` diffs the rows against the build before publishing |
| `complete` | costs, and assets for a job that did not ingest | asset paths re-prefixed and deterministically keyed; `published` refused if any submitted check failed |
| `fail` | error, retryable | three attempts, then a human looks at it |

**Uploads.** The pod never holds a storage credential. It asks for a signed PUT
URL per object, valid 15 minutes, scoped to exactly one path; it cannot list
the bucket, read anything, or write anywhere the function did not name. Object
names are content checksums (`<ab>/<sha256>.spz`), so a re-run that produced
byte-identical assets — SPZ encoding is deterministic — reuses the same objects
and a preempted upload resumes rather than duplicating storage. The world
prefix is added by the function, not the worker.

**Worker identity is provisioned out of band.** `wv-jobs` refuses to register a
worker on first claim, so `WV_WORKER_ID` must already exist in `wv_worker`. That
is a real operational step (see `.env.example`) and it is the point: if a worker
could mint its own identity with the shared secret, anyone holding that secret
could create untraceable workers and the queue would stop being auditable.

**What the pod still cannot do, and does not need to.** It cannot read another
world, enumerate the queue, publish a world whose checks failed, or write any
table directly. The one thing this costs: a stage that genuinely needed ad-hoc
database access would have to have an action added to `wv-jobs` rather than
reaching for a key. Nothing in the current thirteen stages does.

---

## Licence position

**Hard rule: nothing Inria-derived.** The original
`graphdeco-inria/gaussian-splatting` rasteriser and everything built on it —
2DGS, Mip-Splatting, Scaffold-GS, SuGaR, MILo, 3DGS-MCMC, Gaussian Opacity
Fields — is research-only licensed and would make this product unshippable.
**gsplat only** (Apache-2.0). Where a technique exists only in one of those
repos it is reimplemented against gsplat's API rather than imported: that
applies to the **Gaussian-Grouping identity head** (rebuilt in `splat.py` on
gsplat's N-dimensional rasterisation path) and the **bilateral grid**
(clean-room in `bilagrid.py` from the published method). MCMC densification
needed no reimplementation — gsplat ships `MCMCStrategy`.

Concerns hit while assembling the stack, all resolved in-tree:

1. **MapAnything ships two checkpoints.** The default is **CC-BY-NC**; only
   `facebook/map-anything-apache` is usable commercially. The Dockerfile pulls
   the Apache one by name and `deps.require_weights` looks for that path
   specifically.
2. **LaMa's weights are CC BY-NC-SA 4.0** even though its code is Apache-2.0.
   The obvious best inpainter for redaction is therefore unusable. Default is
   Telea + destructive blur, which is arguably the right choice anyway.
3. **InsightFace's face detectors (SCRFD, RetinaFace) are non-commercial.**
   Hence YuNet (MIT).
4. **SuperPoint and SuperGlue are research-only** (Magic Leap). Hence ALIKED +
   LightGlue — which is why the brief specified them.
5. **YOLO-World is GPL-3.0** and Ultralytics YOLO is AGPL-3.0. Hence OWLv2 for
   open-vocabulary detection.
6. **SAM 3.1's licence needs checking against your distribution model** before
   launch. SAM 2 shipped Apache-2.0 but the SAM 3 family's terms are the one
   item in this stack that has not been read end to end here, and it is load
   bearing in two stages (`redact` and `semantics`). If it turns out to be
   restricted, `redact` degrades to dilated boxes (already supported, already
   flagged in the output) and `semantics` needs a replacement tracker — there
   is no drop-in.
7. **RoomFormer is MIT** but is a research repository, not a package. It is
   vendored at a pinned ref in the image; pin the commit before launch so a
   silent upstream change cannot alter published floorplans.

---

## Operational notes

- **Resume, not restart.** Every stage checkpoints to
  `<run_dir>/artefacts/<stage>.json` with a fingerprint over its input, its own
  source hash and its dependencies' fingerprints. Editing a threshold in
  `frames.py` invalidates the frame set; a preempted pod resumes from the last
  completed stage. The run directory is keyed by world id and version, never by
  pod.
- **Leasing.** `wv_claim_job` uses `FOR UPDATE SKIP LOCKED` so two pods never
  claim the same world, reclaims expired leases from `leased` *and* `running`,
  and refuses to hand out a job whose dependencies have not succeeded. The
  worker heartbeats every 5 minutes against a 15-minute lease, survives a
  failed heartbeat rather than killing a 15-minute splat over one timed-out
  request, and **stops writing entirely** if a heartbeat comes back 409 — that
  means the lease was reclaimed and another pod is already running the world.
- **Logs** are line-delimited JSON on stdout with `run_id`, `world_id` and
  `stage` on every record, because the only question anyone asks of a pipeline
  log is what happened to world X at stage Y.
- **Asset upload is keyed by content checksum**, and SPZ encoding is
  deterministic, so a re-run that produced identical assets re-uses the same
  storage objects. The `wv_asset` row's id is derived from that name, so a
  re-run updates the row rather than adding a second one beside it.
- **`world.json` in a run directory does not exist any more.** The assembled
  document is `build/world.raw.json`, uploaded under the same name, recorded
  with the reserved `world-raw` chunk key and excluded from the world's own
  asset list. The `world.json` a reader loads is written by the edge function
  from the rows.
- `--dry-run` reports the DAG, each stage's expected artefacts and the cost
  estimate. It does **not** build inputs, run models or write artefacts, and it
  invents nothing.
