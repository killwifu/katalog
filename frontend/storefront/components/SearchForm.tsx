// Поиск по подписям: обычная GET-форма без JS — уходит на /{slug}/search.
export function SearchForm({ slug, initial }: { slug: string; initial?: string }) {
  return (
    <form className="search-form" action={`/${encodeURIComponent(slug)}/search`} method="get">
      <input
        type="search"
        name="q"
        defaultValue={initial ?? ''}
        placeholder="Поиск по всему каталогу"
        maxLength={100}
        required
        aria-label="Поиск по всему каталогу магазина"
      />
      <button type="submit" className="btn btn--primary">
        Найти
      </button>
    </form>
  )
}
