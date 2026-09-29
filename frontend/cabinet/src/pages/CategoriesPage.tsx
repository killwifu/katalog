import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorText, type Album, type Category } from '../api'
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
    .replace(/^-+/, '')
    // Обрезаем раньше, чем снимаем хвостовой дефис: наоборот срез сам его
    // и оставлял. Название «Женская и мужская обувь и сумки из Кореи оптом
    // и в розницу» давало slug, кончающийся дефисом, — сервер такой адрес
    // не принимает, и продавец на первом же экране онбординга получал
    // ошибку в поле, которое заполнили за него. 63 — длина, которая
    // проходит серверную проверку при любом числе дефисов.
    .slice(0, 63)
    .replace(/-+$/, '')
}

// Категории по макету 14 · Desktop: слева дерево, справа содержимое
// выбранной категории. Плоский список не отвечал на главный вопрос —
// что лежит внутри: приходилось открывать альбомы и смотреть у каждого.
export function CategoriesPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })

  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<string>('')

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['categories', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
  }

  const create = useMutation({
    mutationFn: (v: { title: string; parentId: string | null }) =>
      api.createCategory(shop.id, v.title, slugify(v.title), v.parentId ?? undefined),
    onSuccess: (c) => {
      setAdding(null)
      setError('')
      setSelected(c.id)
      refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  const remove = useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo?: string }) =>
      api.deleteCategory(shop.id, id, moveTo),
    onSuccess: () => {
      setSelected(null)
      refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  // Адрес категории при переименовании не трогаем: по нему уже могли
  // разойтись ссылки, и менять его молча нельзя.
  const rename = useMutation({
    mutationFn: (v: { id: string; title: string; slug: string; parentId: string | null }) =>
      api.updateCategory(shop.id, v.id, v.title, v.slug, v.parentId),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  const assign = useMutation({
    mutationFn: (v: { albumId: string; categoryId: string | null }) =>
      api.setAlbumCategory(shop.id, v.albumId, v.categoryId),
    onSuccess: refresh,
    onError: (e: Error) => setError(errorText(e)),
  })

  if (categories.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (categories.isError) return <p className="text-danger">Не удалось загрузить категории.</p>

  const all = categories.data
  const roots = all.filter((c) => !c.parent_id)
  const children = (id: string) => all.filter((c) => c.parent_id === id)
  const albumList = albums.data ?? []
  // В категорию считаем и альбомы её подкатегорий: в макете у родителя
  // стоит сумма, а не только то, что лежит прямо в нём.
  const idsOf = (c: Category) => [c.id, ...children(c.id).map((s) => s.id)]
  const countIn = (c: Category) => albumList.filter((a) => a.category_id && idsOf(c).includes(a.category_id)).length
  const uncategorized = albumList.filter((a) => !a.category_id)

  const current = selected ? all.find((c) => c.id === selected) ?? null : null
  const currentSubs = current ? children(current.id) : []
  const inCurrent = current
    ? albumList.filter((a) => a.category_id && idsOf(current).includes(a.category_id))
    : uncategorized
  const norm = query.trim().toLowerCase()
  const visible = inCurrent
    .filter((a) => !chip || a.category_id === chip)
    .filter((a) => !norm || a.title.toLowerCase().includes(norm))
  const catTitle = (id: string | null) => (id ? all.find((c) => c.id === id)?.title : undefined)

  return (
    <div>
      <div className="page__head">
        <h1>Категории</h1>
        <span className="spacer" />
        <button className="btn btn--primary" onClick={() => setAdding({ parentId: null })}>
          Новая категория
        </button>
      </div>
      <p className="page__lead">
        Группируйте альбомы — покупатели увидят категории на витрине. Максимум два уровня.
      </p>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="cats">
        <div className="cattree">
          <div className="cattree__sum">
            {roots.length} {plural(roots.length, 'категория', 'категории', 'категорий')} ·{' '}
            {all.length - roots.length}{' '}
            {plural(all.length - roots.length, 'подкатегория', 'подкатегории', 'подкатегорий')}
          </div>
          {roots.map((c) => (
            <div key={c.id}>
              <button
                className="cattree__row"
                aria-current={selected === c.id}
                onClick={() => {
                  setSelected(c.id)
                  setChip('')
                }}
              >
                <b className="font-medium">{c.title}</b>
                <span className="spacer" />
                <span className="cnt">{countIn(c)}</span>
              </button>
              {children(c.id).map((sub) => (
                <button
                  key={sub.id}
                  className="cattree__row cattree__row--sub"
                  aria-current={selected === sub.id}
                  onClick={() => {
                    setSelected(sub.id)
                    setChip('')
                  }}
                >
                  {sub.title}
                  <span className="spacer" />
                  <span className="cnt">{countIn(sub)}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="cattree__none">
            <button
              className="cattree__row"
              aria-current={selected === null}
              onClick={() => {
                setSelected(null)
                setChip('')
              }}
            >
              Без категории
              <span className="spacer" />
              <span className="cnt">только вам · {uncategorized.length}</span>
            </button>
          </div>
          <button className="cattree__add" onClick={() => setAdding({ parentId: null })}>
            + Добавить категорию
          </button>
        </div>

        <div className="catpane">
          <div className="catpane__head">
            <h2>{current ? current.title : 'Без категории'}</h2>
            <span className="spacer" />
            {current && (
              <>
                <button className="btn btn--ghost btn--sm" onClick={() => setAdding({ parentId: current.id })}>
                  Подкатегория
                </button>
                <button className="btn btn--primary btn--sm" onClick={() => setPicking(true)}>
                  Добавить альбомы
                </button>
              </>
            )}
          </div>
          <p className="catpane__meta">
            {current ? (
              <>
                {currentSubs.length}{' '}
                {plural(currentSubs.length, 'подкатегория', 'подкатегории', 'подкатегорий')} ·{' '}
                {inCurrent.length} {plural(inCurrent.length, 'альбом', 'альбома', 'альбомов')} · /
                {current.slug}
              </>
            ) : (
              <>Эти альбомы не попадут в меню витрины, пока вы не положите их в категорию</>
            )}
          </p>

          {current && (
            <CategoryActions
              category={current}
              all={all}
              subCount={currentSubs.length}
              onRename={rename.mutate}
              onDelete={remove.mutate}
            />
          )}

          {currentSubs.length > 0 && (
            <div className="chips">
              <button aria-pressed={chip === ''} onClick={() => setChip('')}>
                Все <span className="cnt">{inCurrent.length}</span>
              </button>
              {currentSubs.map((s) => (
                <button key={s.id} aria-pressed={chip === s.id} onClick={() => setChip(s.id)}>
                  {s.title} <span className="cnt">{countIn(s)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="alhead">
            <span className="spacer" />
            <input
              className="inp"
              style={{ maxWidth: 260 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск в категории"
              aria-label="Поиск в категории"
            />
          </div>

          {visible.length === 0 ? (
            <p className="text-sm text-ink-2">
              {norm ? 'Ничего не найдено.' : 'Здесь пока нет альбомов.'}
            </p>
          ) : (
            <div className="algrid">
              {visible.map((a) => (
                <div key={a.id} className="alcard">
                  <Link to="/albums/$albumId" params={{ albumId: a.id }} className="alcard__cover">
                    {a.cover_urls ? (
                      <img src={a.cover_urls.small} alt="" loading="lazy" />
                    ) : (
                      <span className="alcard__cover--empty" aria-hidden="true">▦</span>
                    )}
                    <span className="alcard__count">{a.photo_count} фото</span>
                  </Link>
                  <div className="alcard__body">
                    <b title={a.title}>{a.title}</b>
                    <span className="alcard__cat">{catTitle(a.category_id) ?? 'Без категории'}</span>
                    {current && (
                      <div className="alcard__foot">
                        <span className="spacer" />
                        <button
                          className="text-xs text-ink-2 hover:text-danger"
                          onClick={() => assign.mutate({ albumId: a.id, categoryId: null })}
                          title="Убрать из категории"
                        >
                          Убрать
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {adding && (
        <NewCategoryDialog
          parentTitle={adding.parentId ? catTitle(adding.parentId) : undefined}
          busy={create.isPending}
          onCancel={() => setAdding(null)}
          onCreate={(title) => create.mutate({ title, parentId: adding.parentId })}
        />
      )}

      {picking && current && (
        <PickAlbumsDialog
          albums={albumList.filter((a) => a.category_id !== current.id)}
          categoryTitle={current.title}
          catTitle={catTitle}
          onCancel={() => setPicking(false)}
          onPick={(ids) => {
            for (const id of ids) assign.mutate({ albumId: id, categoryId: current.id })
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

// Переименование и удаление живут в правой панели: в макете это карандаш
// у заголовка и пункт меню «⋯». Удаление спрашивает, куда девать альбомы —
// молча отвязывать нельзя, продавец потеряет раскладку витрины.
function CategoryActions({
  category,
  all,
  subCount,
  onRename,
  onDelete,
}: {
  category: Category
  all: Category[]
  subCount: number
  onRename: (v: { id: string; title: string; slug: string; parentId: string | null }) => void
  onDelete: (v: { id: string; moveTo?: string }) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  const targets = all.filter((c) => c.id !== category.id && !c.parent_id)

  if (editing !== null) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(null)
            if (e.key === 'Enter' && editing.trim()) {
              onRename({ id: category.id, title: editing.trim(), slug: category.slug, parentId: category.parent_id })
              setEditing(null)
            }
          }}
          maxLength={100}
          className="inp flex-1 basis-48"
          aria-label="Название категории"
        />
        <button
          className="btn btn--primary btn--sm"
          disabled={!editing.trim()}
          onClick={() => {
            onRename({ id: category.id, title: editing.trim(), slug: category.slug, parentId: category.parent_id })
            setEditing(null)
          }}
        >
          Сохранить
        </button>
        <button className="btn btn--quiet btn--sm" onClick={() => setEditing(null)}>
          Отмена
        </button>
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-danger">
          Удалить «{category.title}»
          {/* Подкатегории уносятся вместе с родителем (каскад по внешнему
              ключу) — продавец должен видеть, что теряет и структуру. */}
          {subCount > 0 && ` вместе с ${subCount} ${plural(subCount, 'подкатегорией', 'подкатегориями', 'подкатегориями')}`}?
        </span>
        <select className="inp !w-auto max-w-64" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
          <option value="">Альбомы оставить без категории</option>
          {targets.map((c) => (
            <option key={c.id} value={c.id}>
              Перенести альбомы в «{c.title}»
            </option>
          ))}
        </select>
        <button
          className="btn btn--danger btn--sm"
          onClick={() => onDelete({ id: category.id, moveTo: moveTo || undefined })}
        >
          Удалить
        </button>
        <button className="btn btn--quiet btn--sm" onClick={() => setConfirming(false)}>
          Отмена
        </button>
      </div>
    )
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
      <button className="text-ink-2 hover:text-ink" onClick={() => setEditing(category.title)}>
        Переименовать
      </button>
      <button className="text-ink-2 hover:text-danger" onClick={() => setConfirming(true)}>
        Удалить категорию
      </button>
    </div>
  )
}

function NewCategoryDialog({
  parentTitle,
  busy,
  onCancel,
  onCreate,
}: {
  parentTitle?: string
  busy: boolean
  onCancel: () => void
  onCreate: (title: string) => void
}) {
  const [title, setTitle] = useState('')
  return (
    <div className="modal__back" role="dialog" aria-modal="true">
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal__head">
          <div>
            <h2>{parentTitle ? 'Новая подкатегория' : 'Новая категория'}</h2>
            {parentTitle && <p>Внутри «{parentTitle}»</p>}
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={onCancel} aria-label="Закрыть">✕</button>
        </div>
        <div className="modal__body" style={{ gridTemplateColumns: '1fr' }}>
          <label className="field">
            <span>Название</span>
            <input
              className="inp"
              autoFocus
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && title.trim() && onCreate(title.trim())}
              placeholder="Например, Верхняя одежда"
            />
            <p className="hint">Адрес на витрине: /{slugify(title) || '…'}</p>
          </label>
        </div>
        <div className="modal__foot">
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={onCancel}>Отмена</button>
          <button
            className="btn btn--primary"
            disabled={busy || !title.trim()}
            onClick={() => onCreate(title.trim())}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}

function PickAlbumsDialog({
  albums,
  categoryTitle,
  catTitle,
  onCancel,
  onPick,
}: {
  albums: Album[]
  categoryTitle: string
  catTitle: (id: string | null) => string | undefined
  onCancel: () => void
  onPick: (ids: string[]) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const norm = query.trim().toLowerCase()
  const shown = albums.filter((a) => !norm || a.title.toLowerCase().includes(norm))

  return (
    <div className="modal__back" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal__head">
          <div>
            <h2>Добавить альбомы</h2>
            <p>В категорию «{categoryTitle}»</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={onCancel} aria-label="Закрыть">✕</button>
        </div>
        <div className="modal__body" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <input
              className="inp"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по названию"
              aria-label="Поиск по названию"
            />
            <ul className="rows mt-3" style={{ maxHeight: 320, overflow: 'auto' }}>
              {shown.map((a) => (
                <li key={a.id} className="rows__row">
                  <label className="flex flex-1 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={picked.has(a.id)}
                      onChange={() => {
                        const next = new Set(picked)
                        if (next.has(a.id)) next.delete(a.id)
                        else next.add(a.id)
                        setPicked(next)
                      }}
                    />
                    <span className="rows__main">
                      <b>{a.title}</b>
                      <span className="rows__meta">
                        {a.photo_count} фото · {catTitle(a.category_id) ?? 'без категории'}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
              {shown.length === 0 && <li className="rows__row text-sm text-ink-2">Ничего не найдено.</li>}
            </ul>
          </div>
        </div>
        <div className="modal__foot">
          <p className="hint">Выбрано: {picked.size}</p>
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={onCancel}>Отмена</button>
          <button className="btn btn--primary" disabled={picked.size === 0} onClick={() => onPick([...picked])}>
            Добавить
          </button>
        </div>
      </div>
    </div>
  )
}
