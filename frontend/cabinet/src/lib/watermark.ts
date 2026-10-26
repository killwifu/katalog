import type { WatermarkPosition } from '../api'

// Положение знака: клетки сетки через запятую («tl,br») или «tile» — по всей
// области (imagingmeta.WatermarkCells). Пусто — правый нижний угол.
export const WATERMARK_TILE = 'tile'

export function watermarkCells(pos: WatermarkPosition | undefined): string[] {
  if (pos === WATERMARK_TILE) return WATERMARK_POSITIONS.map((p) => p.id)
  return (pos || 'br').split(',')
}

// Нажатие на клетку: добавить или убрать её. Последнюю клетку не убираем —
// знак без места. Из режима «по всей области» клетка переводит в одну точку.
export function toggleWatermarkCell(pos: WatermarkPosition | undefined, cell: string): WatermarkPosition {
  if (pos === WATERMARK_TILE) return cell
  const cells = (pos || 'br').split(',')
  const next = cells.includes(cell) ? cells.filter((c) => c !== cell) : [...cells, cell]
  if (next.length === 0) return cells.join(',')
  // Порядок клеток — как в сетке: иначе «br,tl» и «tl,br» считались разными
  // настройками и сохранение запускало лишнюю перерисовку альбома.
  return WATERMARK_POSITIONS.map((p) => p.id).filter((id) => next.includes(id)).join(',')
}

// Девять точек кадра для водяного знака — та же сетка 3×3, что проверяет
// сервер (imagingmeta.WatermarkPositions). Порядок — построчно сверху вниз.
export const WATERMARK_POSITIONS: { id: string; label: string }[] = [
  { id: 'tl', label: 'сверху слева' },
  { id: 'tc', label: 'сверху по центру' },
  { id: 'tr', label: 'сверху справа' },
  { id: 'ml', label: 'по центру слева' },
  { id: 'mc', label: 'по центру' },
  { id: 'mr', label: 'по центру справа' },
  { id: 'bl', label: 'снизу слева' },
  { id: 'bc', label: 'снизу по центру' },
  { id: 'br', label: 'снизу справа' },
]
