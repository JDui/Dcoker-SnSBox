import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.SNSBOX_WEB_PORT || 18731),
    strictPort: true,
    proxy: {
      '/api': { target: process.env.SNSBOX_API_TARGET || 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: { target: ['es2022', 'safari16.4'], sourcemap: false },
})
