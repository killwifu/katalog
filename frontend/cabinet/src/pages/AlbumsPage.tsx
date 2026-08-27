import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { api, type Album } from '../api'
import { useShop } from './AppLayout'

export function AlbumsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const albums = useQuery({
    queryKey: ['albums', shop.id],
    queryFn: () => api.listAlbums(shop.id),
  })
  const [title, setTitle] = useState('')

  const create = useMutation({
    mutationFn: (t: string) => api.createAlbum(shop.id, t),
    onSuccess: () => {
      setTitle('')
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) create.mutate(title.trim())
  }

  if (albums.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (albums.isError) return <p className="text-danger">Не удалось загрузить альбомы.</p>

  const roots = albums.data.filter((a) => !a.parent_id)
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

      {roots.length === 0 && (
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
            <AlbumRow album={album} />
            {children(album.id).length > 0 && (
              <ul className="border-t border-line bg-surface-alt pl-6">
                {children(album.id).map((child) => (
                  <li key={child.id}>
                    <AlbumRow album={child} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
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

function AlbumRow({ album }: { album: Album }) {
  const status = STATUS[album.status] ?? STATUS.draft
  return (
    <Link to="/albums/$albumId" params={{ albumId: album.id }} className="rows__row">
      <span className="rows__main">
        <b>{album.title}</b>
        <span className="rows__meta">{album.photo_count} фото</span>
      </span>
      <span className={status.cls}>{status.label}</span>
    </Link>
  )
}
