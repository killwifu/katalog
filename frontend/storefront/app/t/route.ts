import { createHash, randomUUID } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { getRedis } from '@/lib/redis'

// Счётчик просмотров витрины: бекон с клиента -> инкремент в Redis.
// Ключи (UTC-даты) агрегирует ночной asynq-джоб воркера в daily_stats.
// НИКАКИХ записей в Postgres на этом пути.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_TTL_SECONDS = 72 * 3600
const VISITOR_COOKIE = 'kv'
const VISITOR_TTL_SECONDS = 365 * 24 * 3600
// Потолок беконов с одного адреса в минуту. Отказ молчаливый: счётчик
// просмотров не тот путь, где стоит объяснять клиенту, что он превысил.
const BEACON_LIMIT_PER_MIN = 60

export async function POST(req: Request): Promise<Response> {
  let shopId = ''
  let albumId = ''
  try {
    const body = (await req.json()) as { shop_id?: unknown; album_id?: unknown }
    if (typeof body.shop_id === 'string') shopId = body.shop_id
    if (typeof body.album_id === 'string') albumId = body.album_id
  } catch {
    return new Response(null, { status: 400 })
  }
  if (!UUID_RE.test(shopId) || (albumId !== '' && !UUID_RE.test(albumId))) {
    return new Response(null, { status: 400 })
  }

  const jar = cookies()
  let visitorId = jar.get(VISITOR_COOKIE)?.value ?? ''
  const isNewVisitor = visitorId === ''
  if (isNewVisitor) visitorId = randomUUID()

  // Последний адрес в цепочке — тот, что дописал наш Caddy. Первый шлёт
  // клиент, и по нему уникальные посетители накручивались заголовком.
  const xff = (headers().get('x-forwarded-for') ?? '').split(',')
  const ip = (xff[xff.length - 1] ?? '').trim()
  const visitorHash = createHash('sha256')
    .update(`${visitorId}|${ip}`)
    .digest('hex')
    .slice(0, 32)

  const date = new Date().toISOString().slice(0, 10)
  const shopKey = `views:${date}:${shopId}:-`
  try {
    const redis = getRedis()

    // Бекон никем не подписан: shop_id лежит в разметке страницы, так что
    // накрутить чужие просмотры можно было скриптом в один цикл. Живому
    // покупателю хватает единиц запросов в минуту; всё сверх — не он.
    const rlKey = `rl:t:${ip}:${Math.floor(Date.now() / 60000)}`
    const hits = await redis.incr(rlKey)
    if (hits === 1) await redis.expire(rlKey, 120)
    if (hits > BEACON_LIMIT_PER_MIN) return new Response(null, { status: 204 })

    const pipe = redis.pipeline()
    pipe.incr(shopKey)
    pipe.expire(shopKey, KEY_TTL_SECONDS, 'NX')
    if (albumId) {
      const albumKey = `views:${date}:${shopId}:${albumId}`
      pipe.incr(albumKey)
      pipe.expire(albumKey, KEY_TTL_SECONDS, 'NX')
    }
    const uvKey = `uv:${date}:${shopId}`
    pipe.pfadd(uvKey, visitorHash)
    pipe.expire(uvKey, KEY_TTL_SECONDS, 'NX')
    await pipe.exec()
  } catch {
    // Redis недоступен — просмотр теряем, страницу не ломаем.
  }

  const res = new Response(null, { status: 204 })
  if (isNewVisitor) {
    res.headers.set(
      'Set-Cookie',
      `${VISITOR_COOKIE}=${visitorId}; Path=/; Max-Age=${VISITOR_TTL_SECONDS}; HttpOnly; SameSite=Lax`,
    )
  }
  return res
}
