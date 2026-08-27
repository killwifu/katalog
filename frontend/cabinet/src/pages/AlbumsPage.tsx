import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
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

      <ul className="space-y-2">
        {roots.map((album) => (
          <li key={album.id}>
            <AlbumRow id={album.id} title={album.title} count={album.photo_count} />
            {children(album.id).length > 0 && (
              <ul className="mt-2 ml-6 space-y-2">
                {children(album.id).map((child) => (
                  <li key={child.id}>
                    <AlbumRow id={child.id} title={child.title} count={child.photo_count} />
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

function AlbumRow({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <Link
      to="/albums/$albumId"
      params={{ albumId: id }}
      className="rows__row rounded-card border border-line bg-surface hover:border-line-strong"
    >
      <span className="font-medium text-ink">{title}</span>
      <span className="text-sm text-ink-2">{count} фото</span>
    </Link>
  )
}
