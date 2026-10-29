import type { ShopPublic } from '@/lib/api'
import { messageText } from '@/lib/links'
import { ContactMenu } from './ContactMenu'
import { ShareButton } from './ShareButton'

const DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })

export type AlbumHeadProps = {
  shop: ShopPublic
  title: string
  photoCount: number
  // Абсолютный адрес альбома — в сообщение продавцу.
  url: string
  // Категории альбома (он может лежать в нескольких): чипы со ссылками.
  categories: { title: string; href: string }[]
  updatedAt?: string
  description?: string
}

// Шапка страницы альбома (макет 15 · «Альбом»): название, чипы категорий,
// «N фото · обновлён <дата>», описание; справа «Поделиться» и «Написать
// продавцу» (на телефоне — под описанием во всю ширину, «Поделиться» иконкой).
export function AlbumHead({ shop, title, photoCount, url, categories, updatedAt, description }: AlbumHeadProps) {
  const updated = updatedAt ? DATE.format(new Date(updatedAt)).replace(/\s*г\.$/, '') : ''
  return (
    <header className="sfalbum">
      <div className="sfalbum__main">
        <h1>{title}</h1>
        <p className="sfalbum__meta">
          {categories.map((c) => (
            <a key={c.href} href={c.href} className="sfalbum__cat">
              {c.title}
            </a>
          ))}
          <span>
            {photoCount} фото{updated && ` · обновлён ${updated}`}
          </span>
        </p>
        {/* Условия отправки и оплаты — до фотографий: покупатель должен
            прочитать их прежде, чем писать продавцу. */}
        {description && <p className="albumdesc">{description}</p>}
      </div>
      <div className="sfalbum__actions">
        <ShareButton title={title} />
        <ContactMenu shop={shop} text={messageText(shop.msg_template, url)} className="sfalbum__write" />
      </div>
    </header>
  )
}
