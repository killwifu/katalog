import { ChevronLeft, ChevronRight } from 'lucide-react'
// Переключатель страниц витрины (макет 15): ‹ 1 2 … ›. Обычные ссылки —
// страницы кешируются и открываются без клиентского кода.
export function Pager({
  page,
  pages,
  href,
  label,
}: {
  page: number
  pages: number
  href: (page: number) => string
  label: string
}) {
  if (pages <= 1) return null
  // Все номера не печатаем: первая, последняя и соседи текущей.
  const shown = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b)
  return (
    <nav className="pager" aria-label={label}>
      {page > 1 ? (
        <a href={href(page - 1)} rel="prev" aria-label="Предыдущая страница">
          <ChevronLeft size={18} strokeWidth={1.6} aria-hidden="true" />
        </a>
      ) : (
        <ChevronLeft size={18} strokeWidth={1.6} aria-hidden="true" />
      )}
      {shown.map((n, i) => (
        <span key={n} className="pager__group">
          {i > 0 && n - shown[i - 1] > 1 && <span className="pager__gap">…</span>}
          {n === page ? (
            <b aria-current="page">{n}</b>
          ) : (
            <a href={href(n)}>{n}</a>
          )}
        </span>
      ))}
      {page < pages ? (
        <a href={href(page + 1)} rel="next" aria-label="Следующая страница">
          <ChevronRight size={18} strokeWidth={1.6} aria-hidden="true" />
        </a>
      ) : (
        <ChevronRight size={18} strokeWidth={1.6} aria-hidden="true" />
      )}
    </nav>
  )
}

// Подпись площадки внизу витрины.
export function PoweredBy() {
  return (
    <p className="powered">
      Витрина работает на <a href="/">Katalog</a>
    </p>
  )
}
