import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { api, type Section, type Tab, errorText} from '../api'
import { useFlip } from '../lib/flip'
import { Icon } from '../lib/icons'
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
  const list = useRef<HTMLDivElement>(null)
  useFlip(list, 'flip-tab')

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
    onError: (e: Error) => setError(errorText(e)),
    mutationFn: (id: string) => api.deleteTab(shop.id, id),
    onSuccess: refresh,
  })

  // ponytail: порядок меняется кнопками, а не перетаскиванием — dnd-kit
  // ради переупорядочивания пяти вкладок не окупается. Если вкладок станет
  // много и порядок начнут менять часто, тогда и библиотека.
  const move = useMutation({
    mutationFn: ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const list = [...(tabs.data ?? [])]
      const target = index + dir
      if (target < 0 || target >= list.length) return Promise.resolve()
      ;[list[index], list[target]] = [list[target], list[index]]
      // Новый порядок — на экран сразу: вкладка плавно едет на место
      // (useFlip), а не ждёт ответа сервера и не прыгает.
      queryClient.setQueryData(['tabs', shop.id], list)
      // Один запрос на весь порядок: два обмена подряд могли оборваться
      // посередине, и кабинет об этом даже не узнавал.
      return api.setTabOrder(shop.id, list.map((t) => t.id))
    },
    // Обновляем и при ошибке: иначе на экране остаётся порядок, которого
    // на витрине нет.
    onSettled: refresh,
    onError: (e: Error) => setError(errorText(e)),
  })

  if (tabs.isPending || sections.isPending || albums.isPending)
    return <p className="text-ink-2">Загрузка…</p>
  if (tabs.isError || sections.isError || albums.isError)
    return <p className="text-danger" role="alert">Не удалось загрузить конструктор.</p>

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
          className="btn btn--primary btn--pill"
        >
          <Icon as={Plus} size={18} />
          Добавить
        </button>
      </form>
      {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}

      <div className="space-y-6" ref={list}>
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
  // Порядок разделов меняем у себя сразу (плавный переезд — useFlip), а на
  // сервер пишем номера всем разделам вкладки: отдельного «порядка» у API
  // разделов нет, есть sort_order в PATCH.
  const [local, setLocal] = useState<Section[] | null>(null)
  const order = local && local.length === sections.length && local.every((s) => sections.some((x) => x.id === s.id)) ? local : sections
  const list = useRef<HTMLDivElement>(null)
  useFlip(list, 'flip-section')
  const moveSection = (i: number, dir: -1 | 1) => {
    const next = [...order]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setLocal(next)
    void Promise.all(next.map((s, k) => api.updateSection(shopId, s.id, s.title, k)))
      .then(onChanged)
      .catch(() => {
        setLocal(null)
        onChanged()
      })
  }
  const create = useMutation({
    mutationFn: () => api.createSection(shopId, tab.id, title.trim()),
    onSuccess: () => {
      setTitle('')
      onChanged()
    },
  })

  return (
    <section className="tabblock" data-flip-tab={tab.id}>
      <header className="tabblock__head">
        <MoveButtons
          label={`вкладку «${tab.title}»`}
          canUp={index > 0}
          canDown={index < total - 1}
          onMove={onMove}
        />
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

      <div className="space-y-3 p-3" ref={list}>
        {order.map((section, i) => (
          <SectionBlock
            key={section.id}
            section={section}
            albums={albums}
            shopId={shopId}
            onChanged={onChanged}
            canUp={i > 0}
            canDown={i < order.length - 1}
            onMove={(dir) => moveSection(i, dir)}
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
          <button type="submit" disabled={!title.trim()} className="btn btn--ghost btn--pill">
            <Icon as={Plus} size={18} />
            Добавить раздел
          </button>
        </form>
        {create.isError && (
          <p className="mt-2 text-sm text-danger" role="alert">{errorText(create.error)}</p>
        )}
      </div>
    </section>
  )
}

function SectionBlock({
  section,
  albums,
  shopId,
  onChanged,
  canUp,
  canDown,
  onMove,
}: {
  section: Section
  albums: { id: string; title: string }[]
  shopId: string
  onChanged: () => void
  canUp: boolean
  canDown: boolean
  onMove: (dir: -1 | 1) => void
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
    <div className="secblock" data-flip-section={section.id}>
      <div className="mb-2 flex items-center gap-2">
        <MoveButtons label={`раздел «${section.title}»`} canUp={canUp} canDown={canDown} onMove={onMove} />
        <span className="flex-1 text-sm font-medium text-ink">{section.title}</span>
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
      {(save.isError || remove.isError) && (
        <p className="mb-2 text-xs text-danger" role="alert">{errorText(save.error ?? remove.error!)}</p>
      )}
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

// Стрелки «выше / ниже» — иконками по центру круглых кнопок (раньше —
// символы ↑↓ в текстовых кнопках).
function MoveButtons({
  label,
  canUp,
  canDown,
  onMove,
}: {
  label: string
  canUp: boolean
  canDown: boolean
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <span className="movebtns">
      <button type="button" onClick={() => onMove(-1)} disabled={!canUp} aria-label={`Поднять ${label}`}>
        <Icon as={ArrowUp} size={16} />
      </button>
      <button type="button" onClick={() => onMove(1)} disabled={!canDown} aria-label={`Опустить ${label}`}>
        <Icon as={ArrowDown} size={16} />
      </button>
    </span>
  )
}
