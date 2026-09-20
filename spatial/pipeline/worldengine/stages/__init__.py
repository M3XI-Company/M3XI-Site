"""Pipeline stages.

Every module here follows the same shape so the runner can treat them
identically and so each is independently runnable and testable:

    SUMMARY: str            one line, shown by --dry-run
    USES_GPU: bool          whether GPU seconds are billed to it
    PRODUCES: tuple[str]    filenames it writes under data/<stage>/
    @dataclass Input        everything it reads, fully serialisable
    @dataclass Output       everything it writes, fully serialisable
    build_input(ctx, upstream) -> Input
    run(inp, ctx) -> Output

`run` is pure-ish: given the same Input and the same files on disk it produces
the same Output. Side effects are confined to ctx.data_dir(). That is what
makes the runner's fingerprint cache sound.
"""
from __future__ import annotations

STAGES = ("ingest", "frames", "redact", "pose", "scale", "splat", "mesh",
          "layout", "semantics", "graph", "regions", "package", "quality")
