import { X } from 'lucide-react'

// Поиск по названиям альбомов (макет 15): обычная GET-форма без JS — уходит
// на /{slug}/search. from — откуда пришли: «Сбросить поиск» и крестик
// в поле возвращают туда.
export function SearchForm({ slug, initial, from }: { slug: string; initial?: string; from: string }) {
  return (
    <form className="search-form" action={`/${encodeURIComponent(slug)}/search`} method="get">
      <input
        type="search"
        name="q"
        defaultValue={initial ?? ''}
        placeholder="Поиск по альбомам"
        maxLength={100}
        required
        aria-label="Поиск по альбомам магазина"
      />
      <input type="hidden" name="from" value={from} />
      {initial && (
        <a className="search-form__clear" href={from} aria-label="Сбросить поиск">
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </a>
      )}
      {/* Кнопки в макете нет: поиск уходит по Enter. Сама кнопка остаётся
          для скринридера и для клавиатуры телефона («Найти»). */}
      <button type="submit" className="sr-only">
        Найти
      </button>
    </form>
  )
}
