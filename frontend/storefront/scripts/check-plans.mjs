// Цены и лимиты на витрине должны совпадать с тем, что система реально
// списывает и считает. Однажды они разошлись полностью: страница обещала
// «Базовый 290 ₽ / 500 фото», а биллинг брал 490 ₽ и разрешал 5000 фото.
// Скрипт сверяет app/(marketing)/pricing/plans.ts с дефолтами
// backend/internal/config/config.go и падает при расхождении.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const goSrc = readFileSync(join(root, 'backend/internal/config/config.go'), 'utf8')
const tsSrc = readFileSync(
  join(root, 'frontend/storefront/app/(marketing)/pricing/plans.ts'),
  'utf8',
)

// getenvInt64("PLAN_BASIC_MAX_STORAGE_MB", 10*1024) -> 10240
function goDefault(name) {
  const m = goSrc.match(new RegExp(`"${name}",\\s*([0-9*\\s]+)\\)`))
  if (!m) throw new Error(`не найден дефолт ${name} в config.go`)
  return m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1)
}

// Тарифы витрины: id -> цена ₽/мес.
const tsPrices = new Map(
  [...tsSrc.matchAll(/id: '(\w+)',\s*\n\s*name: '[^']*',\s*\n\s*price: (\d+),/g)].map((m) => [
    m[1],
    Number(m[2]),
  ]),
)

// Строка матрицы: значения по тарифам, пробелы-разделители разрядов долой.
function matrixRow(label) {
  const m = tsSrc.match(new RegExp(`label: '${label}'[^}]*values: \\{([^}]*)\\}`))
  if (!m) throw new Error(`не найдена строка сравнения «${label}» в plans.ts`)
  return new Map(
    [...m[1].matchAll(/(\w+): '([^']*)'/g)].map(([, id, v]) => [id, v.replace(/\s| /g, '')]),
  )
}
const tsPhotos = matrixRow('Фотографии')
const tsStorage = matrixRow('Хранилище')

const errors = []
function eq(what, actual, expected) {
  if (String(actual) !== String(expected)) {
    errors.push(`${what}: на витрине ${actual}, в config.go ${expected}`)
  }
}

for (const [id, envPrefix] of [
  ['free', 'FREE'],
  ['basic', 'BASIC'],
  ['pro', 'PRO'],
]) {
  if (!tsPrices.has(id)) {
    errors.push(`тариф «${id}» есть в config.go, но не показан на витрине`)
    continue
  }
  // У бесплатного тарифа цены в конфиге нет — на витрине это 0 ₽.
  const price = envPrefix === 'FREE' ? 0 : goDefault(`PLAN_${envPrefix}_PRICE_RUB`)
  eq(`цена «${id}»`, tsPrices.get(id), price)
  eq(`фото «${id}»`, tsPhotos.get(id), goDefault(`PLAN_${envPrefix}_MAX_PHOTOS`))
  eq(`хранилище «${id}»`, tsStorage.get(id), `${goDefault(`PLAN_${envPrefix}_MAX_STORAGE_MB`) / 1024}ГБ`)
}
for (const id of tsPrices.keys()) {
  if (!['free', 'basic', 'pro'].includes(id)) {
    errors.push(`тариф «${id}» показан на витрине, но система его не знает`)
  }
}

if (errors.length > 0) {
  console.error('тарифы витрины разошлись с биллингом:')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log(`ok: ${tsPrices.size} тарифа совпадают с config.go (цена, фото, хранилище)`)
