import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getShopPage, getTabSections } from '@/lib/api'
import { ShopHeader } from '@/components/ShopHeader'
import { ShopTabs } from '@/components/ShopTabs'
import { AlbumGrid } from '@/components/AlbumGrid'

export const revalidate = 60

export function generateStaticParams(): { slug: string; tabSlug: string }[] {
  return []
}

type Props = {
  params: { slug: string; tabSlug: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, tabSlug } = params
  const data = await getShopPage(slug)
  const tab = data?.tabs.find((t) => t.slug === tabSlug)
  if (!data || !tab) return { title: 'Раздел не найден' }
  return {
    title: `${tab.title} — ${data.shop.name}`,
    description: data.shop.description || undefined,
  }
}

export default async function TabPage({ params }: Props) {
  const { slug, tabSlug } = params
  const [data, sections] = await Promise.all([getShopPage(slug), getTabSections(slug, tabSlug)])
  if (!data || !sections) notFound()
  const tab = data.tabs.find((t) => t.slug === tabSlug)
  if (!tab) notFound()

  return (
    <main className="page">
      <ShopHeader shop={data.shop} />
      <ShopTabs
        shopSlug={slug}
        tabs={data.tabs}
        hasSections={data.sections.length > 0}
        activeSlug={tabSlug}
      />

      {/* Системная вкладка «Альбомы» — все альбомы по дате, без секций. */}
      {tabSlug === 'albums' ? (
        <AlbumGrid shopSlug={slug} albums={data.albums.filter((a) => !a.parent_id)} />
      ) : sections.every((s) => s.albums.length === 0) ? (
        <p className="empty">В этом разделе пока ничего нет.</p>
      ) : (
        sections.filter((s) => s.albums.length > 0).map((section) => (
          <section key={section.title} className="section">
            <h2 className="section__head">{section.title}</h2>
            <AlbumGrid shopSlug={slug} albums={section.albums} />
          </section>
        ))
      )}
    </main>
  )
}
