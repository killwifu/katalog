import { notFound, redirect } from 'next/navigation'
import { ShopUnavailableError, getCategories, getShopPage, withAlbumCounts } from '@/lib/api'
import { ShopHeader } from './ShopHeader'
import { TrackView } from './TrackView'
import { ShopUnavailable } from './ShopUnavailable'
import { AlbumGrid } from './AlbumGrid'
import { Pager, PoweredBy } from './Pager'
import { albumsWord } from './ShopHeader'
import { EmptyState } from './EmptyState'
import { ContactMenu } from './ContactMenu'
import { SortMenu } from './SortMenu'
import { listHref, type AlbumSort } from '@/lib/sort'
import { messageText } from '@/lib/links'

// Макет 15: на странице главной 4 раздела, в разделе до 12 альбомов.
const HOME_SECTIONS = 4
const HOME_BLOCK_ALBUMS = 12
// Когда разделов нет, главная показывает альбомы одной сеткой, как «Альбомы».
export const ALBUMS_PER_PAGE = 24

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
  // Разделы: категории верхнего уровня с пометкой «На главной», в порядке
  // из кабинета. Пустая категория тоже раздел — с надписью вместо альбомов
  // (макет 15 · «пустая категория»). Подкатегории отдельно не
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
  const sections = data.sections.filter((s) => s.albums.length > 0)
  const newestFirst = [...topLevel].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))

  const base = `/${encodeURIComponent(slug)}`
  const pageHref = (n: number) => (n === 1 ? base : `${base}/p/${n}`)
  // Выкладка продавца (секции вкладки «Главная») важнее автоматической.
  const mode = sections.length > 0 ? 'sections' : blocks.some((b) => b.total > 0) ? 'blocks' : 'grid'
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
        nav={{ tabs: data.tabs, categories: cats, active: 'home', empty: topLevel.length === 0 }}
        from={pageHref(page)}
      />
      {topLevel.length === 0 ? (
        <EmptyShop shop={shop} />
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
              {block.total > 0 && <a href={`${base}/c/${encodeURIComponent(block.slug)}`}>Все {block.total} →</a>}
            </div>
            {block.total > 0 ? (
              <AlbumGrid shopSlug={slug} albums={block.albums} row />
            ) : (
              <p className="catempty">Владелец витрины ещё не добавил альбомы в эту категорию</p>
            )}
          </section>
        ))
      ) : (
        // Разделов нет — все альбомы одной сеткой, как «Альбомы» (макет 15 ·
        // «Главная · нет категорий»): от новых к старым. Главная статическая
        // (ISR, без query), поэтому «Больше фото» ведёт во вкладку «Альбомы».
        <>
          <AllAlbumsHead count={newestFirst.length} sort="new" base={`${base}/t/albums`} />
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
// и сортировка справа; base — страница, на которую ведёт выбор сортировки.
export function AllAlbumsHead({ count, sort, base }: { count: number; sort: AlbumSort; base: string }) {
  return (
    <div className="cathead cathead--all">
      <h2>Все альбомы</h2>
      <span>
        {count} {albumsWord(count)}
      </span>
      <SortMenu sort={sort} hrefs={{ new: listHref(base, 'new'), photos: listHref(base, 'photos') }} />
    </div>
  )
}

// Витрина без опубликованных альбомов (макет 15 · «Пустая витрина»).
export function EmptyShop({ shop }: { shop: Parameters<typeof ContactMenu>[0]['shop'] }) {
  return (
    <EmptyState
      icon="inbox"
      title="Здесь пока нет альбомов"
      text="Продавец ещё наполняет витрину. Загляните позже или напишите ему — он подскажет, что есть в наличии."
    >
      <ContactMenu shop={shop} text={messageText(shop.msg_template, '')} about="" />
    </EmptyState>
  )
}
