# World Viewer page

The browser experience a prospective tenant or buyer enters instead of
travelling to a property.

## Run it

From `spatial/`:

    npm install
    npm run build          # builds world-core, spatial-engine, viewer
    npx vite apps/view     # http://127.0.0.1:5183

Or as part of the main site, from the repo root: `npm run dev`, then
`/spatial/apps/view/`. The root `vite.config.js` adds the page to the site
build only when `spatial/node_modules/three` exists, so a deploy without the
spatial workspace installed is unaffected.

## Query parameters

| Parameter | Effect |
| --- | --- |
| `world=<url>` | Load a `WorldDocument` as JSON. Defaults to the demo flat. |
| `splat=<url>` | Attach a real `.spz` / `.sog` / `.ply` to the demo world. |
| `embed=1` | White-label visitor mode: branding, no operator controls. |
| `operator=1` | Internal review: diagnostics panel, unsurveyed space enterable. |
| `theme=light\|dark` | Overrides the visitor's system setting. |
| `at=<navNodeId>` | Start somewhere other than the entrance. |
| `brand=`, `logo=`, `accent=`, `listing=` | Embed branding. |

With no `splat` and no `world`, the splat assets are removed rather than left
pointing at a file that is not there, and the viewer runs its proxy-only shell:
the state an operator reviews before a capture is published.

## Embedding on an agency site

One iframe, no build step:

```html
<iframe
  src="https://m3xi.com/spatial/apps/view/?world=/worlds/w_123/world.json&embed=1&brand=Hamptons&accent=%23123a5f"
  title="Walk through 12 Example Street"
  style="width:100%;aspect-ratio:16/10;border:0"
  allow="fullscreen; xr-spatial-tracking"
  loading="lazy"
></iframe>
```

`title` is required for WCAG 4.1.2; the viewer cannot supply it from inside the
frame. Everything else — keyboard operation, the written tour, the provenance
hatching, measurement — works identically inside the frame.
