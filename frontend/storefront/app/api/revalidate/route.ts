import { revalidateTag } from 'next/cache'

// Вебхук ревалидации от Go API/воркера: инвалидирует ISR-кеш магазина
// (тег shop:{slug}) при изменении магазина/альбома/фото.
// Защищён shared secret; без секрета в env — выключен.
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.REVALIDATE_SECRET
  if (!secret || req.headers.get('x-revalidate-secret') !== secret) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  let slug: unknown
  try {
    const body = (await req.json()) as { slug?: unknown }
    slug = body.slug
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 })
  }
  if (typeof slug !== 'string' || slug === '' || slug.length > 63) {
    return Response.json({ error: 'invalid_slug' }, { status: 400 })
  }
  revalidateTag(`shop:${slug}`)
  return Response.json({ revalidated: true })
}
