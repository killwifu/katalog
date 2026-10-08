import type { LucideIcon, LucideProps } from 'lucide-react'

// Иконки макета v2 — набор Lucide. Толщина линии в макете — стандартная
// Lucide (2 на сетке 24), кроме мест, где дизайнер оставил другую: таблица
// ниже собрана аудитом по всем кадрам Figma (иконка@размер → толщина на 24).
// Размер — как у экземпляра в макете: 14 в подсказках, 16 в кнопках и
// селектах, 18 в меню, 24 в «Быстром доступе».
const STROKE: Record<string, number> = {
  'Image@32': 1.75,
  'ChevronDown@16': 1.6,
  'ChevronLeft@16': 1.6,
  'Upload@18': 1.75,
  'FolderPlus@18': 1.75,
  'Upload@24': 1.6,
  'Droplet@24': 1.6,
  'MessageCircle@24': 1.6,
  'SlidersHorizontal@24': 1.6,
  'Trash2@24': 1.6,
  'Folder@18': 1.6,
  'SlidersHorizontal@18': 1.6,
  'LogOut@18': 1.6,
  'Copy@16': 1.6,
  'Download@16': 1.6,
  'X@13': 2.2,
  'X@18': 2.2,
  'Trash2@16': 2.25,
  'Check@12': 3,
  'Check@14': 3.43,
  'Check@16': 2.2,
  'Check@22': 2.4,
}
export function Icon({ as: Glyph, size = 16, ...rest }: { as: LucideIcon } & LucideProps) {
  const sw = STROKE[`${Glyph.displayName}@${size}`] ?? 2
  return <Glyph size={size} strokeWidth={sw} aria-hidden="true" focusable="false" {...rest} />
}

// Своих иконок в макете три — их в Lucide нет.

// «Статистика витрины» (09 · Быстрый доступ): три столбика разной высоты.
export function ChartIcon({ size = 24, ...rest }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M12 20V10M18 20V4M6 20V16" />
    </svg>
  )
}

// Спиннер «Готовим архив…» (13): бледное кольцо и бегущая дуга.
export function SpinnerIcon({ size = 20, ...rest }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" className="spin" {...rest}>
      <circle cx="10" cy="10" r="7.5" opacity="0.28" />
      <path d="M17.5 10A7.5 7.5 0 0 0 10 2.5" />
    </svg>
  )
}

// «На главной» у категории (14): домик.
export function HomeIcon({ size = 12, ...rest }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12.3 12.3" fill="none" stroke="currentColor" strokeWidth={1.33} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M4.66 11.66V7.66H7.66V11.66M0.66 5.16L6.16 0.66L11.66 5.16V11.66H0.66V5.16Z" />
    </svg>
  )
}
