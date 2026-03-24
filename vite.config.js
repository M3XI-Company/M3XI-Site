import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        contact: resolve(__dirname, 'contact/index.html'),
        privacy: resolve(__dirname, 'privacy/index.html'),
        startup: resolve(__dirname, 'startup/index.html'),
        team: resolve(__dirname, 'team/index.html'),
        terms: resolve(__dirname, 'terms/index.html'),
      },
    },
  },
})
