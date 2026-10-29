import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useState } from 'react'
import type { Category } from '../api'
import { Popover } from './Popover'
import { fold } from '../lib/fold'
import { Icon } from '../lib/icons'

// Выбор категорий у папки в массовой загрузке (макет 10) и у альбома
// (макет 11–12 · «Выбор категорий»): список с поиском и деревом, можно
// отметить несколько. В поле — первая (подкатегория — с путём «Категория:
// Подкатегория») и «+N»; ничего не отмечено — «Без категории».
// sheet — на телефоне шторкой снизу с «Готово» (окна альбома).
export function CategoryPicker({
  categories,
  value,
  onChange,
  disabled,
  sheet,
}: {
  categories: Category[]
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  sheet?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Свёрнутые категории — по стрелке слева (макет 10).
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const path = (id: string) => {
    const c = categories.find((x) => x.id === id)
    const parent = c?.parent_id ? categories.find((x) => x.id === c.parent_id) : undefined
    return parent ? `${parent.title}: ${c?.title}` : (c?.title ?? '')
  }
  const label = value.length === 0 ? 'Без категории' : path(value[0])
  const more = value.length > 1 ? `+${value.length - 1}` : undefined
  const norm = fold(query.trim())
  const match = (c: Category) => !norm || fold(c.title).includes(norm)
  const roots = categories.filter((c) => !c.parent_id)
  const subs = (id: string) => categories.filter((c) => c.parent_id === id)
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])

  if (disabled) {
    return (
      <span className="catpick__static" title={label}>
        {label}
        {more && ` ${more}`}
      </span>
    )
  }
  return (
    <Popover
      open={open}
      onToggle={setOpen}
      label={label}
      badge={more}
      title="Категории"
      active={value.length > 0}
      sheet={sheet}
    >
      {/* Макет 10 · «Массовая · Выбор категории у папки»: поиск с лупой,
          категории сворачиваются стрелкой, выбранная строка подсвечена. */}
      <div className="catpick">
        {sheet && <p className="catpick__note">Можно выбрать несколько</p>}
        <label className="catpick__search">
          <Icon as={Search} size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти категорию"
            aria-label="Найти категорию"
            autoFocus
          />
        </label>
        <div className="catpick__list">
          {roots.length === 0 && <p className="catpick__empty">Категорий пока нет</p>}
          {roots.map((root) => {
            const children = subs(root.id).filter(match)
            if (!match(root) && children.length === 0) return null
            const expanded = norm !== '' || !folded.has(root.id)
            return (
              <div key={root.id}>
                <div className={`catpick__row ${value.includes(root.id) ? 'is-on' : ''}`}>
                  {subs(root.id).length > 0 ? (
                    <button
                      type="button"
                      className="catpick__fold"
                      aria-expanded={expanded}
                      aria-label={expanded ? `Свернуть «${root.title}»` : `Развернуть «${root.title}»`}
                      onClick={() =>
                        setFolded((prev) => {
                          const next = new Set(prev)
                          if (!next.delete(root.id)) next.add(root.id)
                          return next
                        })
                      }
                    >
                      <Icon as={expanded ? ChevronDown : ChevronRight} size={16} />
                    </button>
                  ) : (
                    <span className="catpick__fold" aria-hidden="true" />
                  )}
                  <label>
                    <input type="checkbox" checked={value.includes(root.id)} onChange={() => toggle(root.id)} />
                    {root.title}
                  </label>
                </div>
                {expanded &&
                  children.map((sub) => (
                    <div key={sub.id} className={`catpick__row catpick__sub ${value.includes(sub.id) ? 'is-on' : ''}`}>
                      <label>
                        <input type="checkbox" checked={value.includes(sub.id)} onChange={() => toggle(sub.id)} />
                        {sub.title}
                      </label>
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
        {/* «Без категории» — не пункт списка (макет 11): снять все галочки. */}
        {sheet && (
          <button type="button" className="btn btn--primary catpick__done" onClick={() => setOpen(false)}>
            Готово
          </button>
        )}
      </div>
    </Popover>
  )
}
