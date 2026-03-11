import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/admin-auth.js'),
      formats: ['es'],
      fileName: 'admin-auth',
    },
    outDir: 'public',
    emptyOutDir: false,
  },
})
