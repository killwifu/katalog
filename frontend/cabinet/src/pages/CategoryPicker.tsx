import { useState } from 'react'
import type { Category } from '../api'
import { Popover } from './Popover'
import { fold } from '../lib/fold'

// Выбор категорий у папки в массовой загрузке (макет 10): список с поиском
// и деревом, можно отметить несколько. В поле — первая и «+N»; ничего не
// отмечено — «Без категории».
export function CategoryPicker({
  categories,
  value,
  onChange,
  disabled,
}: {
  categories: Category[]
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const title = (id: string) => categories.find((c) => c.id === id)?.title ?? ''
  const label =
    value.length === 0 ? 'Без категории' : value.length === 1 ? title(value[0]) : `${title(value[0])} +${value.length - 1}`
  const norm = fold(query.trim())
  const match = (c: Category) => !norm || fold(c.title).includes(norm)
  const roots = categories.filter((c) => !c.parent_id)
  const subs = (id: string) => categories.filter((c) => c.parent_id === id)
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])

  if (disabled) {
    return (
      <span className="catpick__static" title={label}>
        {label}
      </span>
    )
  }
  return (
    <Popover open={open} onToggle={setOpen} label={label} title="Категория" active={value.length > 0}>
      <div className="catpick">
        <input
          className="inp"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти категорию"
          aria-label="Найти категорию"
          autoFocus
        />
        <div className="catpick__list">
          {roots.length === 0 && <p className="catpick__empty">Категорий пока нет</p>}
          {roots.map((root) => {
            const children = subs(root.id).filter(match)
            if (!match(root) && children.length === 0) return null
            return (
              <div key={root.id}>
                <label>
                  <input type="checkbox" checked={value.includes(root.id)} onChange={() => toggle(root.id)} />
                  {root.title}
                </label>
                {children.map((sub) => (
                  <label key={sub.id} className="catpick__sub">
                    <input type="checkbox" checked={value.includes(sub.id)} onChange={() => toggle(sub.id)} />
                    {sub.title}
                  </label>
                ))}
              </div>
            )
          })}
        </div>
        {value.length > 0 && (
          <button className="catpick__clear" onClick={() => onChange([])}>
            Сбросить — без категории
          </button>
        )}
      </div>
    </Popover>
  )
}
