// Серверные фетчеры публичного API Go. Все запросы кешируются data cache
// Next с тегом shop:{slug}: вебхук /api/revalidate инвалидирует мгновенно,
// TTL 60 сек — фолбэк. Горячий путь покупателя не трогает Postgres напрямую.

const API_URL = process.env.API_URL ?? 'http://localhost:8080'

export type ShopPublic = {
  id: string
  slug: string
  name: string
  description: string
  contacts: Record<string, string>
  msg_template: string
  // Время ответа продавца — показывается рядом с кнопками связи.
  reply_time?: string
}

export type AlbumPublic = {
  // «По ссылке»: альбом убран из списков витрины, значит и в поиске ему
  // не место — страница получает noindex.
  unlisted?: boolean
  // Описание отдаётся только на странице альбома, в сетке его нет.
  description?: string
  id: string
  parent_id: string | null
  title: string
  photo_count: number
  cover_urls?: PhotoUrls
  // Слаги категорий альбома (он может лежать в нескольких) — по ним
  // главная собирает блоки категорий.
  category_slugs?: string[]
  // Место альбома в каждой из категорий (слаг → номер).
  category_pos?: Record<string, number>
  // Когда альбом создан — только в сетке магазина; «Альбомы» показывают
  // их от новых к старым.
  created_at?: string
  // Альбом закрыт паролем: в сетке у него замок вместо обложки.
  has_password?: boolean
  // Содержимое не отдано — нужен пароль (см. LockedAlbum).
  locked?: boolean
}

export type PhotoUrls = { small: string; medium: string; large: string }

export type PhotoPublic = {
  id: string
  album_id: string
  caption: string
  width: number
  height: number
  urls: PhotoUrls
}

// empty — своя вкладка без видимых альбомов: в навигации не показываем.
export type TabPublic = { title: string; slug: string; empty?: boolean }

export type SectionPublic = { title: string; albums: AlbumPublic[] }

export type ShopPage = {
  shop: ShopPublic
  albums: AlbumPublic[]
  tabs: TabPublic[]
  sections: SectionPublic[]
}

export type CategoryPublic = {
  parent_slug: string | null
  title: string
  slug: string
  album_count: number
  // Категория показывается блоком на главной витрины.
  on_home?: boolean
}

export type AlbumPage = {
  shop: ShopPublic
  album: AlbumPublic
  // Подальбомы открытого альбома. Пусто у обычного альбома.
  children: AlbumPublic[]
  photos: PhotoPublic[]
  page: number
  per_page: number
  total: number
}

// Витрина, скрытая за неоплату: API отдаёт 410 с контактами продавца.
// Отличаем от 404, чтобы показать страницу «временно недоступна», а не
// «не найдено» — покупатель должен суметь написать продавцу.
export type ShopUnavailable = {
  shop: { name: string; contacts: Record<string, string> }
}

export class ShopUnavailableError extends Error {
  constructor(readonly payload: ShopUnavailable) {
    super('shop unavailable')
  }
}

// loadOrUnavailable — 410 приходит на любой запрос к магазину, а не только
// к его корню. Покупатель чаще всего заходит по прямой ссылке на альбом
// из мессенджера, и без разбора этой ошибки на вложенных страницах он
// видел бы служебный экран Next вместо контактов продавца.
export async function loadOrUnavailable<T>(
  load: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; payload: ShopUnavailable }> {
  try {
    return { ok: true, data: await load() }
  } catch (e) {
    if (e instanceof ShopUnavailableError) return { ok: false, payload: e.payload }
    throw e
  }
}

async function getJSON<T>(path: string, slug: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, {
    next: { revalidate: 60, tags: [`shop:${slug}`] },
  })
  if (res.status === 404) return null
  if (res.status === 410) {
    throw new ShopUnavailableError((await res.json()) as ShopUnavailable)
  }
  if (!res.ok) {
    throw new Error(`API ${path}: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function getShopPage(slug: string): Promise<ShopPage | null> {
  return getJSON<ShopPage>(`/api/v1/public/shops/${encodeURIComponent(slug)}`, slug)
}

export function getAlbumPage(slug: string, albumId: string, page: number): Promise<AlbumPage | null> {
  const params = page > 1 ? `?page=${page}` : ''
  return getJSON<AlbumPage>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/albums/${encodeURIComponent(albumId)}${params}`,
    slug,
  )
}

export function searchPhotos(slug: string, q: string): Promise<{ photos: PhotoPublic[] } | null> {
  return getJSON<{ photos: PhotoPublic[] }>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/search?q=${encodeURIComponent(q)}`,
    slug,
  )
}

export function getTabSections(slug: string, tabSlug: string): Promise<SectionPublic[] | null> {
  return getJSON<SectionPublic[]>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/tabs/${encodeURIComponent(tabSlug)}`,
    slug,
  )
}

export function getCategories(slug: string): Promise<CategoryPublic[] | null> {
  return getJSON<CategoryPublic[]>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/categories`,
    slug,
  )
}

export function getCategoryAlbums(slug: string, categorySlug: string): Promise<AlbumPublic[] | null> {
  return getJSON<AlbumPublic[]>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/categories/${encodeURIComponent(categorySlug)}`,
    slug,
  )
}

export async function getSitemapShops(): Promise<{ slug: string; updated_at: string }[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/public/sitemap`, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { shops: { slug: string; updated_at: string }[] }
    return data.shops ?? []
  } catch {
    // API недоступен (например, во время next build) — пустой sitemap.
    return []
  }
}

// Счётчики категорий для меню витрины — по тем же альбомам, что покупатель
// увидит, открыв категорию: сетка магазина уже без пустых и скрытых
// альбомов, а категория верхнего уровня показывает и альбомы подкатегорий.
// album_count из API считает только прямые привязки, и у родителя с
// альбомами в подкатегориях стоял бы ноль.
export function withAlbumCounts(categories: CategoryPublic[], albums: AlbumPublic[]): CategoryPublic[] {
  const top = albums.filter((a) => !a.parent_id)
  return categories.map((c) => {
    const slugs = new Set([c.slug, ...categories.filter((s) => s.parent_slug === c.slug).map((s) => s.slug)])
    return { ...c, album_count: top.filter((a) => a.category_slugs?.some((s) => slugs.has(s))).length }
  })
}
