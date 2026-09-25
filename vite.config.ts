import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// 参考 ai-interview-questions：前端统一走同源 /api，dev 经 proxy 转发到 Express，
// 避免 CORS；生产由 Express 直接 serve dist/，同样同源。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
