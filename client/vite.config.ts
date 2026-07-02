import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  optimizeDeps: {
    include: ['@monaco-editor/react']
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Tách Monaco Editor thành chunk riêng để lazy-load
          'monaco-editor': ['@monaco-editor/react']
        }
      }
    }
  }
});