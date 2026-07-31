import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Кабинет раздаётся за Caddy по префиксу /app/*.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  server: {
    // Локальная разработка: API и медиа — через Caddy стека (localhost:80).
    proxy: {
      '/api': 'http://localhost',
      '/media': 'http://localhost',
    },
  },
})
