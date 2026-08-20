import type { AlbumPublic } from '@/lib/api'

// Сетка альбомов: одна разметка для главной, секций, вкладок и категорий.
// Ссылки обычными <a>, без next/link — горячий путь покупателя не должен
// тянуть клиентский роутер (бюджет 100 КБ gzip на страницу).
export function AlbumGrid({ shopSlug, albums }: { shopSlug: string; albums: AlbumPublic[] }) {
  if (albums.length === 0) return null
  return (
    <ul className="album-grid">
      {albums.map((album) => (
        <li key={album.id} className="album-card">
          <a href={`/${encodeURIComponent(shopSlug)}/a/${album.id}`}>
            {album.cover_urls ? (
              <img
                src={album.cover_urls.thumb}
                srcSet={`${album.cover_urls.thumb} 300w, ${album.cover_urls.medium} 800w`}
                sizes="(max-width: 860px) 50vw, 25vw"
                alt=""
                loading="lazy"
                width={300}
                height={375}
              />
            ) : (
              <span className="album-placeholder" aria-hidden="true" />
            )}
            <span className="album-title">{album.title}</span>
            <span className="album-count">{album.photo_count}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}
