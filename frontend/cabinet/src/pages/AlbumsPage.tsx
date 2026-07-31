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

  if (albums.isPending) return <p className="text-gray-500">Загрузка…</p>
  if (albums.isError) return <p className="text-red-600">Не удалось загрузить альбомы.</p>

  const roots = albums.data.filter((a) => !a.parent_id)
  const children = (parentId: string) => albums.data.filter((a) => a.parent_id === parentId)

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-gray-900">Альбомы</h1>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название нового альбома"
          className="flex-1 rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={create.isPending || !title.trim()}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Создать
        </button>
      </form>
      {create.isError && <p className="mb-4 text-sm text-red-600">Не удалось создать альбом.</p>}

      {roots.length === 0 && <p className="text-gray-500">Пока нет альбомов — создайте первый.</p>}

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
      className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-400"
    >
      <span className="font-medium text-gray-900">{title}</span>
      <span className="text-sm text-gray-500">{count} фото</span>
    </Link>
  )
}
