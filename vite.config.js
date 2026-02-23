import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        startup: resolve(__dirname, "startup.html"),
        product: resolve(__dirname, "product.html"),
        portfolio: resolve(__dirname, "portfolio.html"),
        privacy: resolve(__dirname, "privacy.html")
      }
    }
  }
});
