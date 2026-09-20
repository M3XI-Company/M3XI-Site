import { defineConfig } from "vite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// The ops panel is gitignored (see .gitignore) because this repo is public, so
// it exists locally but NOT on the build server. Listing it unconditionally
// would fail every Vercel build with a missing-input error.
const panel = resolve(__dirname, "panel/index.html");
const wallet = resolve(__dirname, "panel/wallet.html");
const privatePages = {
  ...(existsSync(panel) ? { panel } : {}),
  ...(existsSync(wallet) ? { panelWallet: wallet } : {}),
};

// M3XI SPATIAL — World Viewer. The viewer page lives in the spatial workspace
// (spatial/apps/view) and is built from package SOURCE via the aliases below,
// so the site build does not depend on `tsc -b` having run in spatial/.
//
// It is added CONDITIONALLY, the same way the ops panel is: spatial/node_modules
// is gitignored, so on a build server that has not run `npm install` inside
// spatial/ the three.js and Spark imports would not resolve and every deploy
// would fail on a missing input. Absent those modules, the site builds exactly
// as it did before this entry existed.
const spatialRoot = resolve(__dirname, "spatial");
const viewerPage = resolve(spatialRoot, "apps/view/index.html");
const consolePage = resolve(spatialRoot, "apps/console/index.html");
const capturePage = resolve(spatialRoot, "apps/capture/index.html");
const spatialInstalled =
  existsSync(resolve(spatialRoot, "node_modules/three")) &&
  existsSync(resolve(spatialRoot, "node_modules/@sparkjsdev/spark"));
const spatialPages = {
  ...(spatialInstalled && existsSync(viewerPage) ? { worldViewer: viewerPage } : {}),
  // The operator console. Guarded on spatialInstalled for the same reason as
  // the viewer: it reaches @m3xi/viewer through the correction editor and the
  // compliance centre, so it needs three.js and Spark resolvable.
  ...(spatialInstalled && existsSync(consolePage) ? { worldConsole: consolePage } : {}),
  // The capture PWA is guarded on the PAGE alone, not on spatialInstalled: it
  // imports neither three.js nor Spark -- it is a camera, a worker and some
  // arithmetic -- so a build server without spatial/node_modules can still
  // ship the thing an operator holds in their hand at the property.
  ...(existsSync(capturePage) ? { worldCapture: capturePage } : {})
};
// `@m3xi/world-core` resolves at types.ts rather than index.ts because index.ts
// re-exports through a './types.js' specifier that only resolves after a
// TypeScript build; spatial/vitest.config.ts does the same for the same reason.
const spatialAliases = spatialInstalled
  ? {
      "@m3xi/viewer": resolve(spatialRoot, "packages/viewer/src/index.ts"),
      "@m3xi/spatial-engine/fixtures/flat": resolve(
        spatialRoot,
        "packages/spatial-engine/src/__fixtures__/flat.ts"
      ),
      "@m3xi/spatial-engine": resolve(spatialRoot, "packages/spatial-engine/src/index.ts"),
      "@m3xi/world-core": resolve(spatialRoot, "packages/world-core/src/types.ts"),
      "@m3xi/console-ui": resolve(spatialRoot, "packages/console-ui/src/index.ts"),
      // `three/addons/*` must come BEFORE the bare `three` alias and must be
      // spelled out. Aliasing a package to a DIRECTORY bypasses its package
      // exports map, and three publishes addons only through that map
      // ("./addons/*" -> "./examples/jsm/*"). Without this line, anything
      // importing three/addons -- Spark's post-processing passes among them --
      // fails the build with a missing Pass.js, which reads like a broken
      // install rather than a resolution rule.
      "three/addons/": resolve(spatialRoot, "node_modules/three/examples/jsm") + "/",
      three: resolve(spatialRoot, "node_modules/three"),
      "@sparkjsdev/spark": resolve(spatialRoot, "node_modules/@sparkjsdev/spark")
    }
  : {};

// capture-core is aliased unconditionally, because the capture page is built
// unconditionally and the package depends only on @m3xi/world-core.
const captureAliases = existsSync(capturePage)
  ? {
      "@m3xi/capture-core": resolve(spatialRoot, "packages/capture-core/src/index.ts"),
      "@m3xi/world-core": resolve(spatialRoot, "packages/world-core/src/types.ts")
    }
  : {};

export default defineConfig({
  resolve: { alias: { ...captureAliases, ...spatialAliases } },
  // The capture app analyses frames on a worker thread so a 50-90 ms blur
  // measurement never blocks the preview the operator is walking with. Vite
  // needs to be told to emit ES workers; the default iife build cannot carry
  // the module imports the analyser uses.
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: {
        ...privatePages,
        ...spatialPages,
        // The front page is CallMe. Cornelia, AutoUV and the old CallMe
        // waitlist page moved to _on_hold/ on 13 Sep 2026; vercel.json
        // redirects their old URLs.
        index: resolve(__dirname, "index.html"),
        // CallMe questions and safety have their own pages; the front page
        // forwards the old #faq / #safety links to them.
        questions: resolve(__dirname, "questions/index.html"),
        safety: resolve(__dirname, "safety/index.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        terms: resolve(__dirname, "terms/index.html"),
        // Required by Google Play: a deletion route reachable WITHOUT installing
        // the app. Every page needs an explicit entry here or Vite never emits it.
        deleteAccount: resolve(__dirname, "delete-account/index.html"),
        // Google Play child safety standards policy (dating/social apps) requires
        // a published CSAE standards page; the Play declaration links here.
        childSafety: resolve(__dirname, "child-safety/index.html"),
        contact: resolve(__dirname, "contact/index.html"),
        services: resolve(__dirname, "services/index.html"),
        jobs: resolve(__dirname, "jobs/index.html"),
        michael: resolve(__dirname, "michael/index.html"),
        team: resolve(__dirname, "team/index.html")
        // The four /studio/ pages that used to be listed here -- index,
        // worlds, business and account -- were DELETED with the rest of the
        // old spatial system, and listing a page that no longer exists is not
        // a warning in Rollup, it is a hard "Could not resolve entry module"
        // that fails the whole deploy. Every m3xi.com build has been failing
        // on studio/index.html since the retirement.
        //
        // They are not replaced here, because what replaced them is not a page
        // in this repo: the World Viewer's operator console and viewer are
        // entries above, built out of spatial/apps. m3xi.com currently has no
        // marketing page for M3XI Spatial at all -- see docs/WORLD_VIEWER.md.
      }
    }
  }
});
