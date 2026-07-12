import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        cornelia: resolve(__dirname, "cornelia.html"),
        autouv: resolve(__dirname, "autouv.html"),
        callme: resolve(__dirname, "callme.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        terms: resolve(__dirname, "terms/index.html"),
        contact: resolve(__dirname, "contact/index.html"),
        projects: resolve(__dirname, "projects/index.html"),
        jobs: resolve(__dirname, "jobs/index.html")
      }
    }
  }
});
