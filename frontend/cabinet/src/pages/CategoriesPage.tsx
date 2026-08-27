import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type Category } from '../api'
import { useShop } from './AppLayout'

// Слаг из названия: кириллица транслитом, всё прочее — в дефис.
// Пользователь может поправить руками, поле открыто.
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .split('')
    .map((ch) => MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function CategoriesPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })

  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [parentId, setParentId] = useState('')
  const [error, setError] = useState('')

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['categories', shop.id] })

  const create = useMutation({
    mutationFn: () => api.createCategory(shop.id, title.trim(), slug || slugify(title), parentId || undefined),
    onSuccess: () => {
      setTitle('')
      setSlug('')
      setParentId('')
      setError('')
      void refresh()
    },
    onError: (e: Error) => setError(e.message),
  })

  const remove = useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo?: string }) =>
      api.deleteCategory(shop.id, id, moveTo),
    onSuccess: () => void refresh(),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) create.mutate()
  }

  if (categories.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (categories.isError) return <p className="text-danger">Не удалось загрузить категории.</p>

  const roots = categories.data.filter((c) => !c.parent_id)
  const children = (id: string) => categories.data.filter((c) => c.parent_id === id)

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold text-ink">Категории</h1>
      <p className="mb-4 text-sm text-ink-2">
        Классификация альбомов, максимум два уровня. Покупатель видит их в меню витрины.
      </p>

      <form onSubmit={submit} className="mb-6 flex flex-wrap gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название"
          className="inp min-w-40 flex-1"
        />
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={slugify(title) || 'адрес'}
          className="inp min-w-40 flex-1"
        />
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="inp"
        >
          <option value="">Верхний уровень</option>
          {roots.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="btn btn--primary"
        >
          Добавить
        </button>
      </form>
      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {roots.length === 0 ? (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">🗂</div>
          <h3>Категорий пока нет</h3>
          <p>
            Категории — это классификация альбомов: покупатель находит по ним товар
            в меню витрины. Двух уровней достаточно.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {roots.map((c) => (
            <li key={c.id}>
              <Row category={c} all={categories.data} onDelete={remove.mutate} />
              {children(c.id).length > 0 && (
                <ul className="border-t border-line bg-surface-alt pl-6">
                  {children(c.id).map((sub) => (
                    <li key={sub.id}>
                      <Row category={sub} all={categories.data} onDelete={remove.mutate} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Удаление спрашивает, куда девать альбомы: молча отвязывать нельзя,
// продавец потеряет раскладку витрины и не поймёт почему.
function Row({
  category,
  all,
  onDelete,
}: {
  category: Category
  all: Category[]
  onDelete: (v: { id: string; moveTo?: string }) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  const targets = all.filter((c) => c.id !== category.id && !c.parent_id)

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="flex-1 text-sm text-ink">{category.title}</span>
      <code className="text-xs text-ink-3">/{category.slug}</code>
      {confirming ? (
        <>
          <select
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            className="inp"
          >
            <option value="">Оставить без категории</option>
            {targets.map((c) => (
              <option key={c.id} value={c.id}>
                Перенести в «{c.title}»
              </option>
            ))}
          </select>
          <button
            onClick={() => onDelete({ id: category.id, moveTo: moveTo || undefined })}
            className="btn btn--danger btn--sm"
          >
            Удалить
          </button>
          <button onClick={() => setConfirming(false)} className="text-xs text-ink-2">
            Отмена
          </button>
        </>
      ) : (
        <button onClick={() => setConfirming(true)} className="text-xs text-ink-2 hover:text-danger">
          Удалить
        </button>
      )}
    </div>
  )
}
