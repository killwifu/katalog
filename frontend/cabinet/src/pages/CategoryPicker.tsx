import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useState } from 'react'
import type { Category } from '../api'
import { Popover } from './Popover'
import { fold } from '../lib/fold'
import { Icon } from '../lib/icons'

// Выбор категорий у папки в массовой загрузке (макет 10): список с поиском
// и деревом, можно отметить несколько. В поле — первая и «+N»; ничего не
// отмечено — «Без категории». single — одна категория (окна альбома):
// вместо плоского <select>, где подкатегории сливались с категориями.
export function CategoryPicker({
  categories,
  value,
  onChange,
  disabled,
  single,
}: {
  categories: Category[]
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  single?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Свёрнутые категории — по стрелке слева (макет 10).
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const title = (id: string) => categories.find((c) => c.id === id)?.title ?? ''
  const label =
    value.length === 0 ? 'Без категории' : value.length === 1 ? title(value[0]) : `${title(value[0])} +${value.length - 1}`
  const norm = fold(query.trim())
  const match = (c: Category) => !norm || fold(c.title).includes(norm)
  const roots = categories.filter((c) => !c.parent_id)
  const subs = (id: string) => categories.filter((c) => c.parent_id === id)
  const toggle = (id: string) => {
    if (single) {
      onChange([id])
      setOpen(false)
      return
    }
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }
  const kind = single ? 'radio' : 'checkbox'

  if (disabled) {
    return (
      <span className="catpick__static" title={label}>
        {label}
      </span>
    )
  }
  return (
    <Popover open={open} onToggle={setOpen} label={label} title="Категория" active={value.length > 0}>
      {/* Макет 10 · «Массовая · Выбор категории у папки»: поиск с лупой,
          категории сворачиваются стрелкой, выбранная строка подсвечена. */}
      <div className="catpick">
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
                    <input
                      type={kind}
                      checked={value.includes(root.id)}
                      onChange={() => toggle(root.id)}
                      // Повторный выбор той же категории onChange не вызывает — просто закрываем.
                      onClick={() => single && value.includes(root.id) && setOpen(false)}
                    />
                    {root.title}
                  </label>
                </div>
                {expanded &&
                  children.map((sub) => (
                    <div key={sub.id} className={`catpick__row catpick__sub ${value.includes(sub.id) ? 'is-on' : ''}`}>
                      <label>
                        <input
                      type={kind}
                      checked={value.includes(sub.id)}
                      onChange={() => toggle(sub.id)}
                      // Повторный выбор той же категории onChange не вызывает — просто закрываем.
                      onClick={() => single && value.includes(sub.id) && setOpen(false)}
                    />
                        {sub.title}
                      </label>
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
        {value.length > 0 && (
          <button
            className="catpick__clear"
            onClick={() => {
              onChange([])
              if (single) setOpen(false)
            }}
          >
            Сбросить — без категории
          </button>
        )}
      </div>
    </Popover>
  )
}
