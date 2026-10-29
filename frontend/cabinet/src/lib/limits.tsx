import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { api, type Shop } from '../api'
import { Icon } from './icons'
import { formatMB, plural } from './uploadRun'

// Проверка лимита тарифа до загрузки (макеты 11–13 · «Лимит фото», «Лимит
// объёма», «Превышены оба лимита»). Пачка проверяется целиком: если она не
// влезает в тариф, не загружается ни одно фото — раньше продавец узнавал о
// лимите по отказу посреди пачки и получал альбом с половиной товара.
//
// Объём считается по размеру выбранных файлов. Сервер учитывает ещё и
// деривативы, поэтому у самой границы он может отказать и после этой
// проверки — тогда сработает прежняя ветка «часть фото не поместилась».
const LIMIT_MARK = 'лимит тарифа превышен'

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1).replace('.', ',')} ГБ` : formatMB(bytes)
}

// Возвращает «на 3 фото и 24 МБ» или null, если пачка помещается.
export function useLimitExcess(shop: Shop): (photos: number, bytes: number) => string | null {
  const billing = useQuery({ queryKey: ['billing', shop.id], queryFn: () => api.getBilling(shop.id) })
  return (photos, bytes) => {
    if (photos === 0) return null
    // Число фото знает только billing; пока он не пришёл, проверяем объём.
    const overPhotos = billing.data ? billing.data.usage.photos + photos - shop.max_photos : 0
    const overBytes = shop.storage_used + bytes - shop.storage_max
    const parts: string[] = []
    if (overPhotos > 0) parts.push(`${overPhotos.toLocaleString('ru-RU')} фото`)
    if (overBytes > 0) parts.push(formatSize(overBytes))
    return parts.length > 0 ? `${LIMIT_MARK} на ${parts.join(' и ')}` : null
  }
}

export function notUploaded(count: number): string {
  return `${count} фото не ${plural(count, 'загружено', 'загружены', 'загружены')}`
}

// Ссылка «смените тариф» рядом с сообщением о лимите.
export function LimitLink({ text }: { text: string }) {
  if (!text.includes(LIMIT_MARK)) return null
  return (
    <>
      {' '}
      <Link to="/billing" className="font-medium underline">
        Сменить тариф
      </Link>
    </>
  )
}

// Ошибка лимита в футере окна загрузки (макет 10 · «Лимит фото / объёма»):
// красная строка «Фото не загружены: лимит тарифа превышен на 4 фото» и
// под ней совет со ссылкой «смените тариф».
export function LimitError({ head, excess, hint }: { head: string; excess: string; hint: string }) {
  return (
    <p className="limerr" role="alert">
      <Icon as={CircleAlert} size={16} />
      <span>
        <b>
          {head}: {excess}
        </b>
        <small>
          {hint}{' '}
          <Link to="/billing">смените тариф</Link>
        </small>
      </span>
    </p>
  )
}
