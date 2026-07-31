import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Для минимального docker-образа (node server.js).
  output: 'standalone',
}

export default nextConfig
