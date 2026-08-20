import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type Section, type Tab } from '../api'
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
    onError: (e: Error) => setError(e.message),
  })

  const deleteTab = useMutation({
    mutationFn: (id: string) => api.deleteTab(shop.id, id),
    onSuccess: refresh,
  })

  if (tabs.isPending || sections.isPending || albums.isPending)
    return <p className="text-gray-500">Загрузка…</p>
  if (tabs.isError || sections.isError || albums.isError)
    return <p className="text-red-600">Не удалось загрузить конструктор.</p>

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) createTab.mutate()
  }

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold text-gray-900">Вкладки и разделы</h1>
      <p className="mb-4 text-sm text-gray-500">
        Вкладка → раздел → альбом. Пока разделов нет, витрина показывает все альбомы по дате.
      </p>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Новая вкладка"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={!title.trim() || createTab.isPending}
          className="rounded bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Добавить
        </button>
      </form>
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <div className="space-y-6">
        {tabs.data.map((tab) => (
          <TabBlock
            key={tab.id}
            tab={tab}
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
  sections,
  albums,
  shopId,
  onChanged,
  onDelete,
}: {
  tab: Tab
  sections: Section[]
  albums: { id: string; title: string }[]
  shopId: string
  onChanged: () => void
  onDelete: () => void
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
    <section className="rounded border border-gray-200">
      <header className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <h2 className="flex-1 text-sm font-medium text-gray-900">{tab.title}</h2>
        <code className="text-xs text-gray-400">/{tab.slug}</code>
        {tab.is_system ? (
          <span className="text-xs text-gray-400">системная</span>
        ) : (
          <button onClick={onDelete} className="text-xs text-gray-500 hover:text-red-600">
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
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
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

  return (
    <div className="rounded bg-gray-50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-sm text-gray-900">{section.title}</span>
        {dirty && (
          <button
            onClick={() => save.mutate()}
            className="rounded bg-gray-900 px-2 py-1 text-xs text-white"
          >
            Сохранить
          </button>
        )}
        <button onClick={() => remove.mutate()} className="text-xs text-gray-500 hover:text-red-600">
          Удалить
        </button>
      </div>
      {albums.length === 0 ? (
        <p className="text-xs text-gray-500">Сначала создайте альбомы.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {albums.map((album) => (
            <li key={album.id}>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={selected.includes(album.id)}
                  onChange={() => toggle(album.id)}
                />
                {album.title}
                {selected.includes(album.id) && (
                  <span className="text-xs text-gray-400">#{selected.indexOf(album.id) + 1}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
