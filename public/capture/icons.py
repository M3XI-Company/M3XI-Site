#!/usr/bin/env python3
"""
Home-screen icons for the capture PWA, generated from the site's own mark.

This script is committed and the three PNGs beside it are its output, because
an icon set nobody can reproduce is an icon set nobody can change. Six months
from now the brand mark moves a millimetre and whoever is holding this repo has
to either redraw four files by eye or leave them wrong. Run this instead:

    python public/capture/icons.py

and it prints every file it wrote with its dimensions and a SHA-256, so a
regeneration can be diffed against what is committed. It is deterministic:
same M.png in, same bytes out.

WHERE THE ARTWORK COMES FROM, AND WHAT WAS REJECTED

  The source is `public/M.png` -- the actual mark the site puts in its header
  and its favicon, a heavy serif "M3/XI" inside a hand-drawn frame. Deriving
  the icon from it means the operator's home screen, the browser tab and the
  letterhead cannot drift apart.

  Rejected: TYPESETTING the wordmark with PIL's freetype. Playfair Display is
  loaded from Google Fonts at runtime and is not a file in this repo, so the
  generator would have had to fall back to whatever serif the machine has --
  georgia.ttf on this Windows box, something else on the Linux build server.
  A generator whose output depends on the machine it ran on is not a generator.

  Rejected: A CAMERA GLYPH. It says "camera", which the phone already has one
  of, and it says nothing about whose camera app this is. The operator is
  looking for M3XI on a crowded home screen, in a hurry, on a doorstep.

  Rejected: A GRADIENT, a photograph, or anything with a light source. At the
  48dp a launcher actually renders, a gradient is a smudge, and this icon sits
  next to a banking app rather than in a portfolio.

WHY PAPER ON INK, WHEN THE SITE IS INK ON PAPER

  Three reasons, in order of how much they matter:

  1. It is found by shape before it is read. A solid dark tile with a light
     mark knocked out of it has one silhouette at 48dp; the site's ink-on-paper
     mark at 48dp is a pale square that disappears into a pale wallpaper.
  2. It matches `background_color` in the manifest exactly, so the launch
     splash -- which is the icon drawn on background_color -- has no visible
     tile edge. The mark simply appears.
  3. It distinguishes the INSTALLED app from a browser tab showing m3xi.com,
     whose favicon is this same mark the other way up. Those are two different
     things and an operator mid-walk should never have to work out which one
     they just tapped.

  Both colours are read from the site's stylesheet (index.html `:root`), not
  invented here: --ink #19150F and --paper #F0E8D8. Contrast between them is
  14.9:1, which clears WCAG AA (4.5:1) and AAA (7:1) with room to spare -- and
  an icon is not text, but the mark still has to survive a dim hallway.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - a missing Pillow must not be mistaken for a bug in the art
    sys.exit(
        "icons.py needs Pillow (PIL). Install it with `python -m pip install Pillow` "
        "and run this again. Nothing was written."
    )

HERE = Path(__file__).resolve().parent
# public/capture/icons.py -> public/M.png. Relative to __file__ rather than the
# working directory so the script runs the same from the repo root, from this
# folder, or from a CI step that never thought about cwd.
MARK_PATH = HERE.parent / "M.png"

# index.html :root --ink and --paper. Kept as ints so the tuple can go straight
# to Pillow; the hex spelling is in the docstring and the README.
INK = (0x19, 0x15, 0x0F)
PAPER = (0xF0, 0xE8, 0xD8)

# How much of the canvas the mark fills, for icons declared `purpose: "any"`.
# 0.74 leaves an eighth of the canvas as margin on each side, which is what
# keeps the mark clear of the rounded corners every launcher and every iOS
# springboard applies to a square icon without asking.
ANY_SCALE = 0.74

# And for `purpose: "maskable"`, where Android crops to a shape it chooses at
# runtime -- circle, squircle, rounded square, teardrop on some OEM skins. The
# guaranteed-visible region is a CIRCLE of diameter 0.8 x the canvas. The
# largest square that fits inside that circle has side 0.8 / sqrt(2) = 0.5657,
# so 0.56 survives every mask, not merely the friendly ones. The usual advice
# ("keep it in the middle 80%") is the SQUARE reading of the safe zone and gets
# the corners of a square mark shaved off by a circular mask.
MASKABLE_SCALE = 0.56

# (filename, pixel size, scale)
OUTPUTS = (
    ("icon-192.png", 192, ANY_SCALE),
    ("icon-512.png", 512, ANY_SCALE),
    ("icon-maskable-512.png", 512, MASKABLE_SCALE),
    # iOS ignores the manifest's icons array for the home screen and uses
    # <link rel="apple-touch-icon"> instead, so without this file an installed
    # capture app on an iPhone gets a screenshot of the page as its icon.
    # 180x180 is the size iOS asks for at @3x; it downsamples for the rest.
    ("apple-touch-icon-180.png", 180, ANY_SCALE),
)


def load_mark() -> Image.Image:
    """
    `public/M.png` as an RGBA image: the mark in PAPER, everything else clear.

    Two decisions worth stating.

    ALPHA FROM INVERTED LUMINANCE, not a threshold. M.png is a 2000x2000 black
    mark on white with antialiased edges, including a hairline hand-drawn frame
    that is about 8 px wide at source. Thresholding at 50% would turn that
    hairline into a staircase once it is resampled to 192 px. Using 255 - L as
    the alpha carries the original's edge softness all the way down.

    CROPPED TO THE MARK, not to the file. The dark content of M.png occupies
    (32, 130) to (1946, 1912) of a 2000 px square -- the margins are uneven by
    about 5% of the height. Centring the FILE would hang the mark visibly low
    and left in the icon; centring the CONTENT is what the eye expects.
    """
    if not MARK_PATH.is_file():
        sys.exit(
            f"icons.py cannot find the brand mark at {MARK_PATH}.\n"
            "It is the only source of artwork here and there is no fallback: an "
            "icon invented on the spot would not be the brand. Nothing was written."
        )

    with Image.open(MARK_PATH) as source:
        grey = source.convert("L")

    alpha = ImageOps.invert(grey)
    box = alpha.getbbox()
    if box is None:
        sys.exit(
            f"icons.py read {MARK_PATH} and found no dark pixels in it at all. "
            "That is not a mark. Nothing was written."
        )

    alpha = alpha.crop(box)

    # Pad the (non-square) mark out to a square so that every later resize is a
    # single uniform scale factor and the aspect ratio of the artwork never
    # changes. The mark measures 1914 x 1782 at source, so this adds 66 px of
    # clear space top and bottom.
    side = max(alpha.size)
    square = Image.new("L", (side, side), 0)
    square.paste(alpha, ((side - alpha.width) // 2, (side - alpha.height) // 2))

    mark = Image.new("RGBA", (side, side), PAPER + (255,))
    mark.putalpha(square)
    return mark


def render(mark: Image.Image, size: int, scale: float) -> Image.Image:
    """The mark, centred at `scale` of the canvas, on an opaque ink ground."""
    canvas = Image.new("RGBA", (size, size), INK + (255,))
    drawn = max(1, round(size * scale))
    # LANCZOS because this is a 10x downsample of fine serif strokes; BILINEAR
    # loses the thin parts of the M and the frame turns grey and uneven.
    resized = mark.resize((drawn, drawn), Image.LANCZOS)
    offset = (size - drawn) // 2
    canvas.alpha_composite(resized, (offset, offset))

    # Flattened to RGB deliberately. The icon is opaque by design -- the ink
    # ground IS the icon -- and an alpha channel on an apple-touch-icon is a
    # standing invitation for iOS to composite it over black, which is how a
    # careful icon ends up looking like a mistake.
    return canvas.convert("RGB")


def main() -> int:
    mark = load_mark()
    print(f"source: {MARK_PATH} -> mark {mark.width}x{mark.height} after crop")

    for name, size, scale in OUTPUTS:
        path = HERE / name
        image = render(mark, size, scale)
        # optimize=True is deterministic in Pillow (it is an exhaustive filter
        # search, not a random one), so regenerating and diffing stays useful.
        image.save(path, format="PNG", optimize=True)

        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()[:16]
        print(
            f"wrote {name:<26} {image.width}x{image.height}  "
            f"{len(data):>6} bytes  mark {scale:.2f} of canvas  sha256:{digest}"
        )

    print(
        "\nThese filenames and sizes are quoted in manifest.webmanifest. "
        "Changing either here means changing it there."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
