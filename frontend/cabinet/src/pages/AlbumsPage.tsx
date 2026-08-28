import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { api, type Album, type Category } from '../api'
import { useShop } from './AppLayout'

export function AlbumsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })
  const albums = useQuery({
    queryKey: ['albums', shop.id],
    queryFn: () => api.listAlbums(shop.id),
  })
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [sort, setSort] = useState<'recent' | 'title' | 'photos'>('recent')

  const create = useMutation({
    mutationFn: (t: string) => api.createAlbum(shop.id, t),
    onSuccess: () => {
      setTitle('')
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  // Удаление уносит и фотографии альбома: их место и место в квоте
  // возвращает сервер, поэтому обновляем и счётчики в меню.
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAlbum(shop.id, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
      void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) create.mutate(title.trim())
  }

  if (albums.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (albums.isError) return <p className="text-danger">Не удалось загрузить альбомы.</p>

  // Фильтрация на клиенте: список альбомов одного продавца ограничен
  // тарифом и целиком уже загружен — гонять за этим сервер незачем.
  const norm = query.trim().toLowerCase()
  const roots = albums.data
    .filter((a) => !a.parent_id)
    .filter((a) => !norm || a.title.toLowerCase().includes(norm))
    .filter((a) => !categoryId || a.category_id === categoryId)
    .sort((x, y) => {
      if (sort === 'title') return x.title.localeCompare(y.title, 'ru')
      if (sort === 'photos') return y.photo_count - x.photo_count
      return 0
    })
  const children = (parentId: string) => albums.data.filter((a) => a.parent_id === parentId)

  return (
    <div>
      <div className="page__head">
        <h1>Альбомы</h1>
        <span className="count">{albums.data.length}</span>
      </div>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название нового альбома"
          className="inp flex-1"
        />
        <button
          type="submit"
          disabled={create.isPending || !title.trim()}
          className="btn btn--primary"
        >
          Создать
        </button>
      </form>
      {create.isError && <p className="mb-4 text-sm text-danger">Не удалось создать альбом.</p>}

      {/* Панель показывается, когда альбомов уже много: на трёх штуках
          она только мешает. */}
      {albums.data.filter((a) => !a.parent_id).length > 5 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
          <input
            className="inp"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию"
            aria-label="Поиск по названию"
          />
          <select
            className="inp"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            aria-label="Категория"
          >
            <option value="">Все категории</option>
            {(categories.data ?? []).map((c: Category) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select
            className="inp"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Сортировка"
          >
            <option value="recent">Сначала новые</option>
            <option value="title">По названию</option>
            <option value="photos">По числу фото</option>
          </select>
        </div>
      )}

      {roots.length === 0 && (norm || categoryId) && (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">🔍</div>
          <h3>Ничего не найдено</h3>
          <p>Попробуйте другое название или снимите фильтр по категории.</p>
        </div>
      )}

      {roots.length === 0 && !norm && !categoryId && (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">📷</div>
          <h3>Альбомов пока нет</h3>
          <p>
            Альбом — это набор фотографий с подписями: цена, размер, артикул.
            Создайте первый и загрузите снимки — витрина соберётся сама.
          </p>
        </div>
      )}

      <ul className="rows">
        {roots.map((album) => (
          <li key={album.id}>
            <AlbumRow album={album} onDelete={remove.mutate} />
            {children(album.id).length > 0 && (
              <ul className="border-t border-line bg-surface-alt pl-6">
                {children(album.id).map((child) => (
                  <li key={child.id}>
                    <AlbumRow album={child} onDelete={remove.mutate} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {remove.isError && <p className="mt-3 text-sm text-danger">Не удалось удалить альбом.</p>}
    </div>
  )
}

// Статусы видны прямо в списке: продавцу важно с одного взгляда понять,
// что покупатель уже видит, а что лежит черновиком.
const STATUS: Record<Album['status'], { label: string; cls: string }> = {
  published: { label: 'Опубликован', cls: 'badge badge--live' },
  unlisted: { label: 'По ссылке', cls: 'badge badge--link' },
  draft: { label: 'Черновик', cls: 'badge badge--draft' },
}

// Удаление в два шага и прямо в строке: отдельного экрана альбом не
// заслуживает, а нативный confirm() не скажет, сколько фотографий уйдёт.
function AlbumRow({ album, onDelete }: { album: Album; onDelete: (id: string) => void }) {
  const status = STATUS[album.status] ?? STATUS.draft
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="rows__row">
      <Link to="/albums/$albumId" params={{ albumId: album.id }} className="rows__main">
        <b>{album.title}</b>
        <span className="rows__meta">{album.photo_count} фото</span>
      </Link>
      {confirming ? (
        <span className="rows__act">
          <span className="rows__meta">
            {album.photo_count > 0
              ? `Удалить вместе с ${album.photo_count} фото?`
              : 'Удалить альбом?'}
          </span>
          <button onClick={() => onDelete(album.id)} className="btn btn--danger btn--sm">
            Удалить
          </button>
          <button onClick={() => setConfirming(false)} className="text-xs text-ink-2">
            Отмена
          </button>
        </span>
      ) : (
        <span className="rows__act">
          <span className={status.cls}>{status.label}</span>
          <button
            onClick={() => setConfirming(true)}
            className="text-xs text-ink-2 hover:text-danger"
          >
            Удалить
          </button>
        </span>
      )}
    </div>
  )
}
