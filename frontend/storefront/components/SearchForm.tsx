// Поиск по подписям: обычная GET-форма без JS — уходит на /{slug}/search.
export function SearchForm({ slug, initial }: { slug: string; initial?: string }) {
  return (
    <form className="search-form" action={`/${encodeURIComponent(slug)}/search`} method="get">
      <input
        type="search"
        name="q"
        defaultValue={initial ?? ''}
        placeholder="Поиск по альбомам"
        maxLength={100}
        required
        aria-label="Поиск по всему каталогу магазина"
      />
      {/* Кнопки в макете нет: поиск уходит по Enter. Сама кнопка остаётся
          для скринридера и для клавиатуры телефона («Найти»). */}
      <button type="submit" className="sr-only">
        Найти
      </button>
    </form>
  )
}
