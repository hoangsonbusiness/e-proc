import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  // Proxy cho `vite preview` để bản build gọi backend qua /api.
  preview: {
    port: 4173,
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
  // Xóa mọi console.* và debugger khỏi output production (sạch hơn sửa 25 chỗ trong source).
  esbuild: {
    drop: ['console', 'debugger'],
  },
  build: {
    // Khóa tường minh: không phát sinh sourcemap (.map) → không khôi phục được source gốc.
    sourcemap: false,
    minify: 'esbuild',
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
