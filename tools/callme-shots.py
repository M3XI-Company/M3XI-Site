"""
The CallMe app screenshots on m3xi.com: check the set, and make the small copies.

The site shows eight 1080x2400 PNG screenshots in phone frames no wider than
about 260px (index.html's hero and gallery, and safety/index.html's hero). Each
<img> offers a 720px-wide WebP copy through srcset, so a phone does not pull a
full PNG for every frame; /shared/site-chrome.js falls back to the PNG if a
copy is missing. Run this after dropping new PNGs into public/img/callme/app/:

    python tools/callme-shots.py            check, then write the WebP copies
    python tools/callme-shots.py --check    check only, write nothing

A copy is rewritten whenever its PNG is newer, so a replaced screenshot never
hides behind an old WebP. Exits 1 if any of the eight PNGs is missing or is not
1080x2400, and lists any other file in the folder, since everything in public/
ships with the site. Needs Pillow.
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "public", "img", "callme", "app")
NAMES = ["lobby-dog", "call", "walk", "map", "snapshot", "poster", "events", "cards"]
SIZE = (1080, 2400)
SMALL_W = 720


def main() -> int:
    check_only = "--check" in sys.argv[1:]
    ok = True
    wanted = set()
    for name in NAMES:
        png = os.path.join(APP, name + ".png")
        webp = os.path.join(APP, f"{name}-{SMALL_W}.webp")
        wanted.update({name + ".png", os.path.basename(webp)})
        if not os.path.exists(png):
            print(f"MISSING   {name}.png")
            ok = False
            continue
        with Image.open(png) as im:
            if im.size != SIZE:
                # No copy from a stand-in: it would outlive the real screenshot
                # if nobody ran this again after dropping it in.
                print(f"WRONG     {name}.png is {im.size[0]}x{im.size[1]}, not {SIZE[0]}x{SIZE[1]}; no copy made")
                ok = False
                continue
            fresh = os.path.exists(webp) and os.path.getmtime(webp) >= os.path.getmtime(png)
            if fresh:
                print(f"ok        {name}.png ({os.path.getsize(png) // 1024} KB), copy up to date")
                continue
            if check_only:
                print(f"STALE     {name}-{SMALL_W}.webp is missing or older than its PNG")
                continue
            h = round(im.size[1] * SMALL_W / im.size[0])
            small = im.convert("RGB").resize((SMALL_W, h), Image.LANCZOS)
            small.save(webp, "WEBP", quality=82, method=6)
            print(f"wrote     {name}-{SMALL_W}.webp ({os.path.getsize(webp) // 1024} KB,"
                  f" from {os.path.getsize(png) // 1024} KB)")
    for extra in sorted(set(os.listdir(APP)) - wanted):
        print(f"UNUSED    {extra} is referenced nowhere but would still deploy from public/")
    print("All eight screenshots are in place." if ok else "Not ready to push: fix the lines above.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
