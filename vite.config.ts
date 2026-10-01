import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5273, strictPort: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
