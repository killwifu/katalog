import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, type Photo } from '../api'
import { useShop } from './AppLayout'

// Экран пакетного проставления подписей: последовательный проход по фото,
// одно текстовое поле, Enter = сохранить и перейти к следующему.
export function CaptionsPage() {
  const shop = useShop()
  const { albumId } = useParams({ from: '/app/albums/$albumId/captions' })

  const photosQuery = useQuery({
    queryKey: ['captions-photos', shop.id, albumId],
    queryFn: () => api.listPhotos(shop.id, albumId),
    staleTime: Infinity,
  })

  const photos = (photosQuery.data ?? []).filter((p) => p.status === 'ready')

  if (photosQuery.isPending) return <p className="text-gray-500">Загрузка…</p>
  if (photosQuery.isError) return <p className="text-red-600">Не удалось загрузить фото.</p>
  if (photos.length === 0) {
    return (
      <div className="text-center text-gray-500">
        <p>Нет готовых фото для подписей.</p>
        <BackLink albumId={albumId} />
      </div>
    )
  }
  return <CaptionWalker photos={photos} albumId={albumId} />
}

function CaptionWalker({ photos, albumId }: { photos: Photo[]; albumId: string }) {
  const [index, setIndex] = useState(0)
  const [caption, setCaption] = useState(photos[0].caption)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const done = index >= photos.length
  const photo = done ? null : photos[index]

  useEffect(() => {
    inputRef.current?.focus()
  }, [index])

  if (!photo) {
    return (
      <div className="text-center">
        <p className="mb-2 text-lg font-medium text-gray-900">Готово!</p>
        <p className="mb-4 text-gray-500">Подписи проставлены для {photos.length} фото.</p>
        <BackLink albumId={albumId} />
      </div>
    )
  }

  const advance = (nextIndex: number) => {
    setIndex(nextIndex)
    if (nextIndex < photos.length) setCaption(photos[nextIndex].caption)
    setError('')
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateCaption(photo.id, caption)
      photos[index] = updated
      advance(index + 1)
    } catch {
      setError('Не удалось сохранить, попробуйте ещё раз')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-3 flex items-center justify-between text-sm text-gray-500">
        <BackLink albumId={albumId} />
        <span>
          {index + 1} / {photos.length}
        </span>
      </div>

      <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <img
          src={photo.urls?.medium ?? photo.urls?.thumb}
          alt=""
          className="mx-auto max-h-96 w-full object-contain"
        />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <input
          ref={inputRef}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Название / цена / артикул — Enter для следующего"
          className="mb-2 w-full rounded border border-gray-300 px-3 py-3 text-base focus:border-blue-500 focus:outline-none"
        />
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Сохранить и дальше
          </button>
          <button
            type="button"
            onClick={() => advance(index + 1)}
            className="rounded border border-gray-300 px-4 py-2 text-gray-600 hover:bg-gray-100"
          >
            Пропустить
          </button>
        </div>
      </form>
    </div>
  )
}

function BackLink({ albumId }: { albumId: string }) {
  return (
    <Link to="/albums/$albumId" params={{ albumId }} className="text-sm text-blue-600 hover:underline">
      ← К альбому
    </Link>
  )
}
