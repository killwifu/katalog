import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type Category, errorText} from '../api'
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
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
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
    onError: (e: Error) => setError(errorText(e)),
  })

  const remove = useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo?: string }) =>
      api.deleteCategory(shop.id, id, moveTo),
    onSuccess: () => void refresh(),
  })

  // Переименование: опечатку в названии иначе можно было исправить только
  // удалением категории — а это ещё и перекладывание всех её альбомов.
  const rename = useMutation({
    mutationFn: ({ id, title, slug, parentId }: { id: string; title: string; slug: string; parentId: string | null }) =>
      api.updateCategory(shop.id, id, title, slug, parentId),
    onSuccess: () => {
      setError('')
      void refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) create.mutate()
  }

  if (categories.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (categories.isError) return <p className="text-danger">Не удалось загрузить категории.</p>

  const albumCount = (categoryId: string) =>
    (albums.data ?? []).filter((a) => a.category_id === categoryId).length
  const roots = categories.data.filter((c) => !c.parent_id)
  const children = (id: string) => categories.data.filter((c) => c.parent_id === id)

  return (
    <div>
      <div className="page__head">
        <h1>Категории</h1>
      </div>
      <p className="page__lead">
        Классификация альбомов, максимум два уровня. Покупатель видит их в меню витрины.
      </p>

      <form onSubmit={submit} className="mb-6 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название"
          className="inp"
        />
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={slugify(title) || 'адрес'}
          className="inp"
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
              <Row category={c} all={categories.data} count={albumCount(c.id)} onDelete={remove.mutate} onRename={rename.mutate} />
              {children(c.id).length > 0 && (
                <ul className="border-t border-line bg-surface-alt pl-6">
                  {children(c.id).map((sub) => (
                    <li key={sub.id}>
                      <Row category={sub} all={categories.data} count={albumCount(sub.id)} onDelete={remove.mutate} onRename={rename.mutate} />
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
  count,
  onDelete,
  onRename,
}: {
  category: Category
  all: Category[]
  count: number
  onDelete: (v: { id: string; moveTo?: string }) => void
  onRename: (v: { id: string; title: string; slug: string; parentId: string | null }) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  // Подкатегории уносятся вместе с родителем (каскад по внешнему ключу),
  // а счётчик показывал только прямые альбомы — продавец не видел, что
  // теряет ещё и вложенную структуру.
  const subCount = all.filter((c) => c.parent_id === category.id).length
  const [editing, setEditing] = useState<string | null>(null)
  const [editParent, setEditParent] = useState<string>(category.parent_id ?? '')
  const targets = all.filter((c) => c.id !== category.id && !c.parent_id)
  const hasChildren = all.some((c) => c.parent_id === category.id)

  // Адрес категории при переименовании не трогаем: по нему уже могли
  // разойтись ссылки, и менять его молча нельзя.
  const submitRename = () => {
    const title = (editing ?? '').trim()
    const parentId = editParent || null
    if (title && (title !== category.title || parentId !== (category.parent_id ?? null))) {
      onRename({ id: category.id, title, slug: category.slug, parentId })
    }
    setEditing(null)
  }

  if (editing !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <input
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename()
            if (e.key === 'Escape') setEditing(null)
          }}
          maxLength={100}
          /* basis, а не просто flex-1: иначе на узком экране поле сжимается
             до пары букв, вместо того чтобы уехать на свою строку. */
          className="inp flex-1 basis-48"
          aria-label="Название категории"
        />
        {/* Категорию с подкатегориями вложить нельзя — дети окажутся
            на третьем уровне, а их всего два. */}
        {!hasChildren && (
          <select
            value={editParent}
            onChange={(e) => setEditParent(e.target.value)}
            className="inp !w-auto max-w-56"
            aria-label="Родительская категория"
          >
            <option value="">Верхний уровень</option>
            {targets.map((c) => (
              <option key={c.id} value={c.id}>
                Внутри «{c.title}»
              </option>
            ))}
          </select>
        )}
        <button onClick={submitRename} className="btn btn--primary btn--sm">
          Сохранить
        </button>
        <button onClick={() => setEditing(null)} className="text-xs text-ink-2">
          Отмена
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="rows__main">
        <b>{category.title}</b>
        <span className="rows__meta">
          /{category.slug} · {count} {count === 1 ? 'альбом' : 'альбомов'}
        </span>
      </span>
      {confirming ? (
        <>
          {subCount > 0 && (
            <span className="rows__meta text-danger">
              вместе с {subCount}{' '}
              {subCount === 1 ? 'подкатегорией' : 'подкатегориями'}
            </span>
          )}
          <select
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            className="inp !w-auto max-w-64"
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
        <>
          <button onClick={() => setEditing(category.title)} className="text-xs text-ink-2">
            Переименовать
          </button>
          <button onClick={() => setConfirming(true)} className="text-xs text-ink-2 hover:text-danger">
            Удалить
          </button>
        </>
      )}
    </div>
  )
}
