import type { Cell } from './plans'

// Ячейка сравнения: галочка / прочерк / текст. Общая для таблицы (десктоп)
// и панелей по тарифам (мобильный) — чтобы значения не разъезжались.
export function CellValue({ value }: { value: Cell }) {
  if (value === true) return <i className="tick" aria-label="есть" />
  if (value === false) return <span className="dash">—</span>
  return <>{value}</>
}
