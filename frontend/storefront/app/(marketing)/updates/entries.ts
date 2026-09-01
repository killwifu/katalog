// Лента обновлений. Пока это данные в коде: админки для наполнения нет
// (см. «Админка → Редактор обновлений» в плане страниц).
// id — якорь в адресе: /updates#2026-08-04.

export type UpdateKind = 'new' | 'improvement' | 'fix'

export type UpdateEntry = {
  id: string
  date: string
  kind: UpdateKind
  title: string
  text: string
  /** Место под скриншот: пока серый блок. */
  shot?: boolean
}

export const KIND_LABELS: Record<UpdateKind, string> = {
  new: 'Новое',
  improvement: 'Улучшение',
  fix: 'Исправление',
}

export const KIND_TAG_CLASS: Record<UpdateKind, string> = {
  new: 'tag',
  improvement: 'tag tag--quiet',
  fix: 'tag tag--faint',
}

export const FILTERS: { value: UpdateKind | 'all'; label: string }[] = [
  { value: 'all', label: 'Всё' },
  { value: 'new', label: 'Новое' },
  { value: 'improvement', label: 'Улучшения' },
  { value: 'fix', label: 'Исправления' },
]

export const ENTRIES: UpdateEntry[] = [
  {
    id: '2026-07-15',
    date: '15 июля',
    kind: 'improvement',
    title: 'Превью ссылки в мессенджерах',
    text: 'При отправке ссылки на альбом в Telegram и WhatsApp теперь показывается обложка, название и количество фотографий, а не пустая карточка.',
  },
  {
    id: '2026-07-08',
    date: '8 июля',
    kind: 'fix',
    title: 'Порядок фото после массовой загрузки',
    text: 'Снимки иногда перемешивались, если загружать их пачкой с телефона. Теперь порядок совпадает с тем, как файлы отсортированы в галерее.',
  },
]
