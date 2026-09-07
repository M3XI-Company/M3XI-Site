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
        // Google Play child safety standards policy (dating/social apps) requires
        // a published CSAE standards page; the Play declaration links here.
        childSafety: resolve(__dirname, "child-safety/index.html"),
        contact: resolve(__dirname, "contact/index.html"),
        services: resolve(__dirname, "services/index.html"),
        jobs: resolve(__dirname, "jobs/index.html"),
        // Studio-first wiring: flagship product page and Michael's profile.
        // team/ was never in this list, so /team/ silently vanished from every
        // build — fixed while adding the new pages.
        studio: resolve(__dirname, "studio/index.html"),
        // The Studio was one 1,900-line page until it was split by job. Each of
        // these is its own entry; they share studio.css and studio-core.js, so
        // Rollup emits the shared parts once.
        studioImages: resolve(__dirname, "studio/images.html"),
        studioVideo: resolve(__dirname, "studio/video.html"),
        studioWorlds: resolve(__dirname, "studio/worlds.html"),
        studioBusiness: resolve(__dirname, "studio/business.html"),
        studioLibrary: resolve(__dirname, "studio/library.html"),
        studioPricing: resolve(__dirname, "studio/pricing.html"),
        studioAccount: resolve(__dirname, "studio/account.html"),
        // The video Editor. Its only module import is the Supabase client from
        // a CDN, exactly like studio/index.html, so it bundles the same way —
        // unlike walkthrough.html and ugc.html, which live under public/ because
        // their importmaps do not survive Rollup.
        studioEditor: resolve(__dirname, "studio/editor.html"),
        michael: resolve(__dirname, "michael/index.html"),
        team: resolve(__dirname, "team/index.html")
      }
    }
  }
});
