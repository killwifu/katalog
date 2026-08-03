// Next 14 (React 18): осознанный выбор ради бюджета JS ≤ 100 КБ gzip —
// рантайм Next 15 + React 19 весит ~100 КБ gzip сам по себе.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Для минимального docker-образа (node server.js).
  output: 'standalone',
  // next/image не используется (свои WebP-деривативы + <img srcset>);
  // выключаем оптимизатор, чтобы не держать лишнюю поверхность атаки.
  images: { unoptimized: true },
}

export default nextConfig
