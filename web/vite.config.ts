import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs separately. Proxying keeps the browser on one origin, so
    // there is no CORS layer to configure and the session cookie story stays
    // simple when one is added.
    proxy: {
      '/api': {
        target: process.env.PLUMBLINE_API_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
