import type { AlbumPublic } from '@/lib/api'
import { LockIcon } from './LockIcon'

// Сетка альбомов: одна разметка для главной, секций, вкладок и категорий.
// Ссылки обычными <a>, без next/link — горячий путь покупателя не должен
// тянуть клиентский роутер (бюджет 100 КБ gzip на страницу).
// row — раздел главной: на телефоне альбомы стоят лентой, которая листается
// вбок (видно два альбома и край третьего), а не сеткой.
export function AlbumGrid({
  shopSlug,
  albums,
  row = false,
}: {
  shopSlug: string
  albums: AlbumPublic[]
  row?: boolean
}) {
  if (albums.length === 0) return null
  return (
    <ul className={row ? 'album-grid album-grid--row' : 'album-grid'}>
      {albums.map((album) => (
        <li key={album.id} className="album-card">
          <a href={`/${encodeURIComponent(shopSlug)}/a/${album.id}`}>
            <span className="album-cover">
              {album.cover_urls ? (
                <img
                  src={album.cover_urls.small}
                  srcSet={`${album.cover_urls.small} 500w, ${album.cover_urls.medium} 800w`}
                  sizes="(max-width: 640px) 45vw, (max-width: 1024px) 25vw, 190px"
                  alt=""
                  loading="lazy"
                  width={300}
                  height={300}
                />
              ) : album.has_password ? (
                // Обложки у закрытого альбома нет намеренно: она выдала бы
                // содержимое до ввода пароля.
                <span className="album-placeholder album-placeholder--lock">
                  <LockIcon />
                  <span>По паролю</span>
                </span>
              ) : (
                <span className="album-placeholder" aria-hidden="true" />
              )}
              <span className="album-count">{album.photo_count} фото</span>
            </span>
            <span className="album-title">{album.title}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}
