import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type Section, type Tab, errorText} from '../api'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { useShop } from './AppLayout'
import { slugify } from './CategoriesPage'

export function TabsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()

  const tabs = useQuery({ queryKey: ['tabs', shop.id], queryFn: () => api.listTabs(shop.id) })
  const sections = useQuery({ queryKey: ['sections', shop.id], queryFn: () => api.listSections(shop.id) })
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })

  const [title, setTitle] = useState('')
  const [error, setError] = useState('')

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tabs', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['sections', shop.id] })
  }

  const createTab = useMutation({
    mutationFn: () => api.createTab(shop.id, title.trim(), slugify(title)),
    onSuccess: () => {
      setTitle('')
      setError('')
      refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  const deleteTab = useMutation({
    mutationFn: (id: string) => api.deleteTab(shop.id, id),
    onSuccess: refresh,
  })

  // ponytail: порядок меняется кнопками, а не перетаскиванием — dnd-kit
  // ради переупорядочивания пяти вкладок не окупается. Если вкладок станет
  // много и порядок начнут менять часто, тогда и библиотека.
  const move = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const list = [...(tabs.data ?? [])]
      const target = index + dir
      if (target < 0 || target >= list.length) return
      const [a, b] = [list[index], list[target]]
      // Меняем местами именно порядковые номера: так соседи не разъезжаются,
      // даже если в базе они шли не подряд.
      await api.reorderTab(shop.id, a.id, a.title, b.sort_order)
      await api.reorderTab(shop.id, b.id, b.title, a.sort_order)
    },
    onSuccess: refresh,
  })

  if (tabs.isPending || sections.isPending || albums.isPending)
    return <p className="text-ink-2">Загрузка…</p>
  if (tabs.isError || sections.isError || albums.isError)
    return <p className="text-danger">Не удалось загрузить конструктор.</p>

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) createTab.mutate()
  }

  return (
    <div>
      <div className="page__head">
        <h1>Вкладки и разделы</h1>
      </div>
      <p className="page__lead">
        Вкладка → раздел → альбом. Пока разделов нет, витрина показывает все альбомы по дате.
      </p>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Новая вкладка"
          className="inp flex-1"
        />
        <button
          type="submit"
          disabled={!title.trim() || createTab.isPending}
          className="btn btn--primary"
        >
          Добавить
        </button>
      </form>
      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="space-y-6">
        {tabs.data.map((tab, i) => (
          <TabBlock
            key={tab.id}
            tab={tab}
            index={i}
            total={tabs.data.length}
            onMove={(dir) => move.mutate({ index: i, dir })}
            sections={sections.data.filter((s) => s.tab_id === tab.id)}
            albums={albums.data}
            shopId={shop.id}
            onChanged={refresh}
            onDelete={() => deleteTab.mutate(tab.id)}
          />
        ))}
      </div>
    </div>
  )
}

function TabBlock({
  tab,
  index,
  total,
  sections,
  albums,
  shopId,
  onChanged,
  onDelete,
  onMove,
}: {
  tab: Tab
  index: number
  total: number
  sections: Section[]
  albums: { id: string; title: string }[]
  shopId: string
  onChanged: () => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const [title, setTitle] = useState('')
  const create = useMutation({
    mutationFn: () => api.createSection(shopId, tab.id, title.trim()),
    onSuccess: () => {
      setTitle('')
      onChanged()
    },
  })

  return (
    <section className="rounded border border-line">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex gap-1">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Поднять вкладку «${tab.title}»`}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={`Опустить вкладку «${tab.title}»`}
          >
            ↓
          </button>
        </span>
        <h2 className="flex-1 text-sm font-medium text-ink">{tab.title}</h2>
        <code className="text-xs text-ink-3">/{tab.slug}</code>
        {tab.is_system ? (
          <span className="text-xs text-ink-3">системная</span>
        ) : (
          <button onClick={onDelete} className="text-xs text-ink-2 hover:text-danger">
            Удалить
          </button>
        )}
      </header>

      <div className="space-y-3 p-3">
        {sections.map((section) => (
          <SectionBlock
            key={section.id}
            section={section}
            albums={albums}
            shopId={shopId}
            onChanged={onChanged}
          />
        ))}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim()) create.mutate()
          }}
          className="flex gap-2"
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Новый раздел"
            className="inp flex-1"
          />
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded border border-line-strong px-3 py-1 text-sm disabled:opacity-50"
          >
            Добавить раздел
          </button>
        </form>
      </div>
    </section>
  )
}

function SectionBlock({
  section,
  albums,
  shopId,
  onChanged,
}: {
  section: Section
  albums: { id: string; title: string }[]
  shopId: string
  onChanged: () => void
}) {
  // ponytail: порядок задаётся порядком выбора, вверх/вниз кнопками нет.
  // Перетаскивание (dnd-kit) — когда порядок станут менять часто.
  const [selected, setSelected] = useState<string[]>(section.album_ids)
  const save = useMutation({
    mutationFn: () => api.setSectionAlbums(shopId, section.id, selected),
    onSuccess: onChanged,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteSection(shopId, section.id),
    onSuccess: onChanged,
  })

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const dirty =
    selected.length !== section.album_ids.length ||
    selected.some((id, i) => section.album_ids[i] !== id)
  useUnsavedGuard(dirty)

  return (
    <div className="rounded bg-surface-alt p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-sm text-ink">{section.title}</span>
        {dirty && (
          <button
            onClick={() => save.mutate()}
            className="btn btn--primary btn--sm"
          >
            Сохранить
          </button>
        )}
        <button onClick={() => remove.mutate()} className="text-xs text-ink-2 hover:text-danger">
          Удалить
        </button>
      </div>
      {albums.length === 0 ? (
        <p className="text-xs text-ink-2">Сначала создайте альбомы.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {albums.map((album) => (
            <li key={album.id}>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input
                  type="checkbox"
                  checked={selected.includes(album.id)}
                  onChange={() => toggle(album.id)}
                />
                {album.title}
                {selected.includes(album.id) && (
                  <span className="text-xs text-ink-3">#{selected.indexOf(album.id) + 1}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
