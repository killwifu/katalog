import { getAlbumPage, ShopUnavailableError } from '@/lib/api'

// Следующие порции фото открытого альбома для подгрузки при прокрутке.
// Отдаются из того же data cache, что и страница (тег shop:{slug}, вебхук
// инвалидирует), — горячий путь покупателя не идёт в Postgres. Закрытый
// паролем альбом отсюда пуст: его фото браузер берёт из API с пропуском.
export async function GET(req: Request, { params }: { params: { slug: string; albumSlug: string } }) {
  const page = Math.min(1_000_000, Math.max(1, Number.parseInt(new URL(req.url).searchParams.get('page') ?? '1', 10) || 1))
  try {
    const data = await getAlbumPage(params.slug, params.albumSlug, page)
    if (!data || data.album.locked) return Response.json({ photos: [] }, { status: 404 })
    return Response.json({ photos: data.photos, page: data.page, total: data.total })
  } catch (e) {
    if (e instanceof ShopUnavailableError) return Response.json({ photos: [] }, { status: 410 })
    throw e
  }
}
