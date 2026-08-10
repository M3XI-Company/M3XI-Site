import { defineConfig } from "vite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// The ops panel is gitignored (see .gitignore) because this repo is public, so
// it exists locally but NOT on the build server. Listing it unconditionally
// would fail every Vercel build with a missing-input error.
const panel = resolve(__dirname, "panel/index.html");
const privatePages = existsSync(panel) ? { panel } : {};

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        ...privatePages,
        index: resolve(__dirname, "index.html"),
        cornelia: resolve(__dirname, "cornelia.html"),
        autouv: resolve(__dirname, "autouv.html"),
        callme: resolve(__dirname, "callme.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        terms: resolve(__dirname, "terms/index.html"),
        // Required by Google Play: a deletion route reachable WITHOUT installing
        // the app. Every page needs an explicit entry here or Vite never emits it.
        deleteAccount: resolve(__dirname, "delete-account/index.html"),
        contact: resolve(__dirname, "contact/index.html"),
        projects: resolve(__dirname, "projects/index.html"),
        jobs: resolve(__dirname, "jobs/index.html"),
        // Studio-first wiring: flagship product page and Michael's profile.
        // team/ was never in this list, so /team/ silently vanished from every
        // build — fixed while adding the new pages.
        studio: resolve(__dirname, "studio/index.html"),
        michael: resolve(__dirname, "michael/index.html"),
        team: resolve(__dirname, "team/index.html")
      }
    }
  }
});
