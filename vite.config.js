import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  // Handle .wasm files as assets
  assetsInclude: ['**/*.wasm'],
  plugins: [
    nodePolyfills({
      include: ['fs', 'os', 'path', 'stream', 'crypto', 'worker_threads', 'perf_hooks'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    {
      name: 'serve-public-index',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '/index.html') {
            req.url = '/public/index.html';
          }
          next();
        });
      }
    }
  ],
  optimizeDeps: {
    // Prevent Vite from pre-bundling the large WASM library
    exclude: ['opencascade.js'],
  },
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
});