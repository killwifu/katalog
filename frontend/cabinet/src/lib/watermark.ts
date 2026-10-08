import type { WatermarkPosition } from '../api'

// Девять точек кадра для водяного знака — та же сетка 3×3, что проверяет
// сервер (imagingmeta.WatermarkPositions). Порядок — построчно сверху вниз.
export const WATERMARK_POSITIONS: { id: WatermarkPosition; label: string }[] = [
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
