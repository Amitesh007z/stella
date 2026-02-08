import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';  // SWC: 10-20x faster than Babel

export default defineConfig({
  plugins: [react()],
  
  // ── Cache directory for faster rebuilds ──────────────────
  cacheDir: 'node_modules/.vite',
  
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    chunkSizeWarningLimit: 600,
    
    // ── Faster rebuilds ─────────────────────────────────────
    target: 'esnext',  // Skip legacy transforms
    cssCodeSplit: true,
    
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'stellar': ['@stellar/freighter-api'],
        },
      },
    },
  },
  
  // ── Optimize deps (pre-bundled for speed) ────────────────
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', '@stellar/freighter-api'],
  },
  
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/info': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
