import type { AlbumPublic } from './api'

export type AlbumSort = 'new' | 'photos'

export function parseSort(v: string | undefined): AlbumSort {
  return v === 'photos' ? 'photos' : 'new'
}

// «Сначала новые» — по дате создания, «Больше фото» — по числу фото
// (при равенстве — новые выше).
export function sortAlbums(albums: AlbumPublic[], sort: AlbumSort): AlbumPublic[] {
  const byDate = (a: AlbumPublic, b: AlbumPublic) => (b.created_at ?? '').localeCompare(a.created_at ?? '')
  return [...albums].sort(sort === 'photos' ? (a, b) => b.photo_count - a.photo_count || byDate(a, b) : byDate)
}

// Адрес страницы списка с сортировкой и номером: без лишних параметров
// у первой страницы и сортировки по умолчанию.
export function listHref(base: string, sort: AlbumSort, page = 1): string {
  const q = new URLSearchParams()
  if (sort !== 'new') q.set('sort', sort)
  if (page > 1) q.set('page', String(page))
  const s = q.toString()
  return s ? `${base}?${s}` : base
}
