// Поиск по подписям: обычная GET-форма без JS — уходит на /{slug}/search.
export function SearchForm({ slug, initial }: { slug: string; initial?: string }) {
  return (
    <form className="search-form" action={`/${encodeURIComponent(slug)}/search`} method="get">
      <input
        type="search"
        name="q"
        defaultValue={initial ?? ''}
        placeholder="Поиск по каталогу"
        maxLength={100}
        required
        aria-label="Поиск по подписям"
      />
      <button type="submit" className="btn btn--primary">
        Найти
      </button>
    </form>
  )
}
