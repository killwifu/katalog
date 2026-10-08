import { notFound, redirect } from 'next/navigation'
import { ShopUnavailableError, getCategories, getShopPage, withAlbumCounts } from '@/lib/api'
import { ShopHeader } from './ShopHeader'
import { TrackView } from './TrackView'
import { ShopUnavailable } from './ShopUnavailable'
import { AlbumGrid } from './AlbumGrid'
import { Pager, PoweredBy } from './Pager'

// Макет 15: на странице главной 4 раздела, в разделе до 12 альбомов.
const HOME_SECTIONS = 4
const HOME_BLOCK_ALBUMS = 12
// Когда разделов нет, главная показывает альбомы одной сеткой, как «Альбомы».
export const ALBUMS_PER_PAGE = 24

export function albumsWord(n: number): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 'альбом'
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'альбома'
  return 'альбомов'
}

// Главная витрины. Первая страница живёт на /{slug}, следующие — на
// /{slug}/p/{n}: адрес без query-строки, поэтому каждая страница остаётся
// статической (ISR) и не рендерится на каждый запрос.
export async function ShopHome({ slug, page }: { slug: string; page: number }) {
  // Категории — второй запрос того же ISR-кеша: тег shop:{slug} общий,
  // вебхук инвалидирует обе выдачи разом.
  let data: Awaited<ReturnType<typeof getShopPage>>
  let categories: Awaited<ReturnType<typeof getCategories>>
  try {
    ;[data, categories] = await Promise.all([getShopPage(slug), getCategories(slug)])
  } catch (e) {
    // Неоплата — не «страница не найдена»: показываем контакты продавца.
    if (e instanceof ShopUnavailableError) return <ShopUnavailable payload={e.payload} />
    throw e
  }
  if (!data) notFound()
  const { shop, albums } = data
  const cats = withAlbumCounts(categories ?? [], albums)
  // Подальбомы показываются внутри родителя; на главной — только верхний уровень.
  const topLevel = albums.filter((a) => !a.parent_id)
  // Разделы: категории верхнего уровня с пометкой «На главной» и хотя бы
  // одним альбомом, в порядке из кабинета. Подкатегории отдельно не
  // показываются — их альбомы идут в раздел родителя. Альбомы без
  // категории на главную не попадают: они есть в «Альбомах».
  const blocks = cats
    .filter((c) => !c.parent_slug && c.on_home)
    .map((c) => {
      const slugs = new Set([c.slug, ...cats.filter((s) => s.parent_slug === c.slug).map((s) => s.slug)])
      // Порядок — как продавец расставил альбомы в категории; альбомы,
      // лежащие только в подкатегориях, идут следом, по своему месту там.
      const place = (a: (typeof topLevel)[number]): [number, number] => {
        const own = a.category_pos?.[c.slug]
        if (own !== undefined) return [0, own]
        const sub = a.category_slugs?.find((s) => slugs.has(s))
        return [1, (sub && a.category_pos?.[sub]) || 0]
      }
      const inside = topLevel
        .filter((a) => a.category_slugs?.some((s) => slugs.has(s)))
        .sort((x, y) => place(x)[0] - place(y)[0] || place(x)[1] - place(y)[1])
      return { slug: c.slug, title: c.title, total: inside.length, albums: inside.slice(0, HOME_BLOCK_ALBUMS) }
    })
    .filter((b) => b.total > 0)
  const sections = data.sections.filter((s) => s.albums.length > 0)
  const newestFirst = [...topLevel].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))

  const base = `/${encodeURIComponent(slug)}`
  const pageHref = (n: number) => (n === 1 ? base : `${base}/p/${n}`)
  // Выкладка продавца (секции вкладки «Главная») важнее автоматической.
  const mode = sections.length > 0 ? 'sections' : blocks.length > 0 ? 'blocks' : 'grid'
  const pages =
    mode === 'blocks'
      ? Math.ceil(blocks.length / HOME_SECTIONS)
      : mode === 'grid'
        ? Math.ceil(topLevel.length / ALBUMS_PER_PAGE)
        : 1
  // Устаревшая ссылка на дальнюю страницу — на первую, а не 404.
  if (page > Math.max(1, pages)) redirect(`/${encodeURIComponent(slug)}`)

  return (
    <main className="page">
      <TrackView shopId={shop.id} />
      <ShopHeader
        shop={shop}
        albumCount={topLevel.length}
        nav={{ tabs: data.tabs, categories: cats, active: 'home' }}
      />
      {topLevel.length === 0 ? (
        <p className="empty">Каталог пока пуст.</p>
      ) : mode === 'sections' ? (
        sections.map((section) => (
          <section key={section.title} className="section section--cat">
            <div className="cathead">
              <h2>{section.title}</h2>
            </div>
            <AlbumGrid shopSlug={slug} albums={section.albums} row />
          </section>
        ))
      ) : mode === 'blocks' ? (
        blocks.slice((page - 1) * HOME_SECTIONS, page * HOME_SECTIONS).map((block) => (
          <section key={block.slug} className="section section--cat">
            <div className="cathead">
              <h2>{block.title}</h2>
              <span>
                {block.total} {albumsWord(block.total)}
              </span>
              <a href={`${base}/c/${encodeURIComponent(block.slug)}`}>Все {block.total} →</a>
            </div>
            <AlbumGrid shopSlug={slug} albums={block.albums} row />
          </section>
        ))
      ) : (
        // Разделов нет — все альбомы одной сеткой, как «Альбомы» (макет 15 ·
        // «Главная · нет категорий»): от новых к старым.
        <>
          <AllAlbumsHead count={newestFirst.length} />
          <AlbumGrid
            shopSlug={slug}
            albums={newestFirst.slice((page - 1) * ALBUMS_PER_PAGE, page * ALBUMS_PER_PAGE)}
          />
        </>
      )}
      <Pager page={page} pages={pages} href={pageHref} label="Страницы главной" />
      <PoweredBy />
    </main>
  )
}

// Заголовок общей сетки (макет 15 · «Альбомы»): «Все альбомы · N альбомов»
// и порядок справа.
export function AllAlbumsHead({ count }: { count: number }) {
  return (
    <div className="cathead cathead--all">
      <h2>Все альбомы</h2>
      <span>
        {count} {albumsWord(count)}
      </span>
      <span className="cathead__sort">Сначала новые</span>
    </div>
  )
}
