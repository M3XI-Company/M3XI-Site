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

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        ...privatePages,
        // The front page is CallMe. Cornelia, AutoUV and the old CallMe
        // waitlist page moved to _on_hold/ on 13 Sep 2026; vercel.json
        // redirects their old URLs.
        index: resolve(__dirname, "index.html"),
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
        team: resolve(__dirname, "team/index.html"),
        // M3XI SPATIAL — what M3XI Studio became: property walkthroughs for
        // agencies. Generation, the Editor, UGC, Free, Library and creator
        // pricing moved to _on_hold/. The viewer (walkthrough.html) lives in
        // public/studio/ because its importmap does not survive Rollup, and
        // capture, tours and the buyer-facing tour live in public/ too.
        studio: resolve(__dirname, "studio/index.html"),
        studioWorlds: resolve(__dirname, "studio/worlds.html"),
        studioBusiness: resolve(__dirname, "studio/business.html"),
        studioAccount: resolve(__dirname, "studio/account.html")
      }
    }
  }
});
