import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getCategories, getShopPage, getTabSections, loadOrUnavailable, withAlbumCounts } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { CHANNEL_LABELS, contactHref, shopChannels } from '@/lib/links'
import { ShopHeader } from '@/components/ShopHeader'
import { AlbumGrid } from '@/components/AlbumGrid'
import { LeadLink } from '@/components/LeadLink'
import { Pager, PoweredBy } from '@/components/Pager'
import { ALBUMS_PER_PAGE, AllAlbumsHead } from '@/components/ShopHome'

// Чтение searchParams (страницы «Альбомов») делает рендер динамическим;
// данные всё равно берутся из data cache с тегом shop:{slug}.
type Props = {
  params: { slug: string; tabSlug: string }
  searchParams: { page?: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, tabSlug } = params
  const res = await loadOrUnavailable(() => getShopPage(slug))
  if (!res.ok) return { title: `${res.payload.shop.name} — каталог временно недоступен` }
  const data = res.data
  const tab = data?.tabs.find((t) => t.slug === tabSlug)
  if (!data || !tab) return { title: 'Раздел не найден' }
  return {
    title: `${tab.title} — ${data.shop.name}`,
    description: data.shop.description || undefined,
  }
}

export default async function TabPage({ params, searchParams }: Props) {
  const { slug, tabSlug } = params
  const res = await loadOrUnavailable(() =>
    Promise.all([getShopPage(slug), getTabSections(slug, tabSlug), getCategories(slug)]),
  )
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const [data, sections, categories] = res.data
  if (!data || !sections) notFound()
  const tab = data.tabs.find((t) => t.slug === tabSlug)
  if (!tab) notFound()
  const channels = shopChannels(data.shop.contacts)
  // «Альбомы» (макет 15): все опубликованные альбомы, в том числе без
  // категории, от новых к старым, по 24 на странице.
  const all = data.albums
    .filter((a) => !a.parent_id)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const pages = Math.max(1, Math.ceil(all.length / ALBUMS_PER_PAGE))
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1)
  const base = `/${encodeURIComponent(slug)}/t/albums`
  // Устаревшая ссылка на дальнюю страницу (альбомов стало меньше) — на
  // первую, как и у страниц альбома; 404 читался как «магазина нет».
  if (tabSlug === 'albums' && page > pages) redirect(base)

  return (
    <main className="page">
      <ShopHeader
        shop={data.shop}
        albumCount={all.length}
        nav={{ tabs: data.tabs, categories: withAlbumCounts(categories ?? [], data.albums), active: tabSlug }}
      />

      {tabSlug === 'albums' ? (
        all.length === 0 ? (
          <p className="empty">Каталог пока пуст.</p>
        ) : (
          <>
            <AllAlbumsHead count={all.length} />
            <AlbumGrid
              shopSlug={slug}
              albums={all.slice((page - 1) * ALBUMS_PER_PAGE, page * ALBUMS_PER_PAGE)}
            />
            <Pager
              page={page}
              pages={pages}
              href={(n) => (n === 1 ? base : `${base}?page=${n}`)}
              label="Страницы альбомов"
            />
          </>
        )
      ) : tabSlug === 'contacts' && sections.every((s) => s.albums.length === 0) ? (
        // Контакты в шапке — мелкой строкой; на своей вкладке покупатель
        // ждёт кнопки, а не «в разделе ничего нет».
        channels.length > 0 ? (
          <div className="contacts-tab">
            <div className="lead-buttons">
              {channels.map(({ channel, value }) => (
                <LeadLink
                  key={channel}
                  shopId={data.shop.id}
                  channel={channel}
                  href={contactHref(channel, value, 'Здравствуйте!')}
                  className={`btn btn-${channel}`}
                >
                  {CHANNEL_LABELS[channel]}
                </LeadLink>
              ))}
            </div>
            <p className="dim">
              {data.shop.reply_time || 'Напишите продавцу — он ответит и подскажет, что есть в наличии.'}
            </p>
          </div>
        ) : (
          <p className="empty">Продавец пока не указал, как с ним связаться.</p>
        )
      ) : sections.every((s) => s.albums.length === 0) ? (
        <p className="empty">В этом разделе пока ничего нет.</p>
      ) : (
        sections.filter((s) => s.albums.length > 0).map((section) => (
          <section key={section.title} className="section section--cat">
            <div className="cathead">
              <h2>{section.title}</h2>
            </div>
            <AlbumGrid shopSlug={slug} albums={section.albums} />
          </section>
        ))
      )}
      <PoweredBy />
    </main>
  )
}
