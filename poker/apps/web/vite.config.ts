import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
      '/avatars': { target: 'http://localhost:3001', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
