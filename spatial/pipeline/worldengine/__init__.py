"""worldengine — M3XI World Viewer reconstruction pipeline.

Turns a phone walkthrough video of a UK property into a WorldDocument that
matches spatial/packages/world-core/src/types.ts exactly: metres, radians,
right-handed, +Y up, quaternions [x, y, z, w], room footprints as XZ rings.

Design rules that are not negotiable anywhere in this package:

  1. No stage ever fabricates model output. If a model or its weights are
     missing, the stage raises StageUnavailable and the run fails loudly.
     A reconstruction pipeline that invents plausible geometry is worse than
     one that stops, because the invented geometry looks fine.
  2. Every fact written carries provenance and confidence. See contract.py.
  3. Redaction runs on frames BEFORE pose/splat, so PII never enters the
     splat in the first place. The DAG enforces this; see runner.py.
  4. No Inria-derived 3DGS code, ever. gsplat only. See LICENCES in README.
"""

__version__ = "0.1.0"

from .contract import (  # noqa: F401
    Grounding,
    Provenance,
    QualityCheck,
    QualityReport,
    WorldDocument,
    weakest_provenance,
)
from .runner import DagRunner, RunContext, StageUnavailable  # noqa: F401
