import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getCategories, getShopPage, getTabSections, loadOrUnavailable, withAlbumCounts } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { CHANNEL_LABELS, channelHandle, contactHref, messageText, NO_TEXT_CHANNELS, shopChannels } from '@/lib/links'
import { listHref, parseSort, sortAlbums } from '@/lib/sort'
import { ShopHeader } from '@/components/ShopHeader'
import { AlbumGrid } from '@/components/AlbumGrid'
import { ChannelIcon } from '@/components/ChannelIcon'
import { LeadLink } from '@/components/LeadLink'
import { Pager, PoweredBy } from '@/components/Pager'
import { ALBUMS_PER_PAGE, AllAlbumsHead, EmptyShop } from '@/components/ShopHome'

// Чтение searchParams (страницы и сортировка «Альбомов») делает рендер
// динамическим; данные всё равно берутся из data cache с тегом shop:{slug}.
type Props = {
  params: { slug: string; tabSlug: string }
  searchParams: { page?: string; sort?: string }
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
  const { shop } = data
  const channels = shopChannels(shop.contacts)
  // «Альбомы» (макет 15): все опубликованные альбомы, в том числе без
  // категории, от новых к старым (или «Больше фото»), по 24 на странице.
  const sort = parseSort(searchParams.sort)
  const top = data.albums.filter((a) => !a.parent_id)
  const all = sortAlbums(top, sort)
  const pages = Math.max(1, Math.ceil(all.length / ALBUMS_PER_PAGE))
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1)
  const base = `/${encodeURIComponent(slug)}/t/${encodeURIComponent(tabSlug)}`
  // Устаревшая ссылка на дальнюю страницу (альбомов стало меньше) — на
  // первую; 404 читался как «магазина нет».
  if (tabSlug === 'albums' && page > pages) redirect(listHref(base, sort))
  const text = messageText(shop.msg_template, '')

  return (
    <main className="page">
      <ShopHeader
        shop={shop}
        albumCount={top.length}
        nav={{
          tabs: data.tabs,
          categories: withAlbumCounts(categories ?? [], data.albums),
          active: tabSlug,
          empty: top.length === 0,
        }}
        from={listHref(base, sort, page)}
      />

      {tabSlug === 'contacts' && sections.every((s) => s.albums.length === 0) ? (
        // «Контакты» (макет 15): каналы списком, «Написать» открывает чат
        // с «Текстом сообщения» из кабинета; Авито — «Открыть» профиль.
        <section className="sfcontacts">
          <div className="cathead">
            <h2>Контакты</h2>
          </div>
          {channels.length > 0 ? (
            <>
              <p className="sfcontacts__sub">Продавец отвечает в мессенджерах — выберите удобный.</p>
              <ul className="sfcontacts__list">
                {channels.map(({ channel, value }) => (
                  <li key={channel}>
                    <ChannelIcon channel={channel} size={44} />
                    <span className="sfcontacts__who">
                      <b>{CHANNEL_LABELS[channel]}</b>
                      <span>{channelHandle(channel, value)}</span>
                      {channel === 'vk' && <small>Текст сообщения в VK не подставится</small>}
                    </span>
                    <LeadLink
                      shopId={shop.id}
                      channel={channel}
                      href={contactHref(channel, value, text)}
                      className={`btn btn--sm sfch sfch--${channel}`}
                      copyText={NO_TEXT_CHANNELS.includes(channel) && channel !== 'avito' ? text : undefined}
                    >
                      {channel === 'avito' ? 'Открыть' : 'Написать'}
                    </LeadLink>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="sfcontacts__sub">Продавец не оставил своих контактов</p>
          )}
        </section>
      ) : top.length === 0 ? (
        // Пустая витрина: заглушка на всех вкладках, кроме «Контактов».
        <EmptyShop shop={shop} />
      ) : tabSlug === 'albums' ? (
        <>
          <AllAlbumsHead count={all.length} sort={sort} base={base} />
          <AlbumGrid shopSlug={slug} albums={all.slice((page - 1) * ALBUMS_PER_PAGE, page * ALBUMS_PER_PAGE)} />
          <Pager page={page} pages={pages} href={(n) => listHref(base, sort, n)} label="Страницы альбомов" />
        </>
      ) : sections.every((s) => s.albums.length === 0) ? (
        <p className="empty">В этом разделе пока ничего нет.</p>
      ) : (
        sections
          .filter((s) => s.albums.length > 0)
          .map((section) => (
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
