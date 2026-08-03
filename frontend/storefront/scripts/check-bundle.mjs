// Бюджет производительности (CLAUDE.md): JS ≤ 100 КБ gzip на страницу
// витрины. Скрипт суммирует gzip-размер всех JS-чанков каждой страницы
// из app-build-manifest и падает при превышении. Запуск после next build.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const LIMIT_BYTES = 100 * 1024

const manifest = JSON.parse(readFileSync('.next/app-build-manifest.json', 'utf8'))
const pages = Object.entries(manifest.pages)
if (pages.length === 0) {
  console.error('app-build-manifest.json is empty — run next build first')
  process.exit(1)
}

const gzipCache = new Map()
function gzipSize(file) {
  if (!gzipCache.has(file)) {
    gzipCache.set(file, gzipSync(readFileSync(join('.next', file))).length)
  }
  return gzipCache.get(file)
}

let failed = false
for (const [route, files] of pages) {
  const scripts = [...new Set(files.filter((f) => f.endsWith('.js')))]
  const total = scripts.reduce((sum, f) => sum + gzipSize(f), 0)
  const kb = (total / 1024).toFixed(1)
  const over = total > LIMIT_BYTES
  console.log(`${over ? 'FAIL' : ' ok '} ${route}: ${kb} KB gzip (${scripts.length} chunks)`)
  if (over) failed = true
}

console.log(`limit: ${LIMIT_BYTES / 1024} KB gzip per page`)
if (failed) {
  console.error('bundle budget exceeded')
  process.exit(1)
}
