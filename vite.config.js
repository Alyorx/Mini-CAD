import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      // Replaces Webpack's "fallback" / "node" object
      include: ['fs', 'os', 'path', 'stream', 'crypto', 'worker_threads', 'perf_hooks'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  optimizeDeps: {
    // Required to prevent Vite from trying to pre-bundle the large library incorrectly
    exclude: ['opencascade.js'],
  },
  build: {
    target: 'esnext', // Ensures compatibility with WASM and modern JS
  },
  // Replaces the "test: /\.wasm$/" rule
  // Vite handles .wasm as static assets automatically or via plugin
  assetsInclude: ['**/*.wasm'], 
});