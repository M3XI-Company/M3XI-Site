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
        privacy: resolve(__dirname, "privacy/index.html")
      }
    }
  }
});
