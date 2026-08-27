import { Dashboard } from '@uppy/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, type AlbumStatus, type Photo } from '../api'
import { createPhotoUppy, type UploadOutcome } from '../lib/uppy'
import { useShop } from './AppLayout'
import '@uppy/core/dist/style.min.css'
import '@uppy/dashboard/dist/style.min.css'

export function AlbumPage() {
  const shop = useShop()
  const { albumId } = useParams({ from: '/app/albums/$albumId' })
  const queryClient = useQueryClient()

  const photos = useQuery({
    queryKey: ['photos', shop.id, albumId],
    queryFn: () => api.listPhotos(shop.id, albumId),
    // Пока есть необработанные фото — опрашиваем статусы.
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.status === 'processing' || p.status === 'uploading')
        ? 2000
        : false,
  })

  const [outcome, setOutcome] = useState<UploadOutcome | null>(null)
  const [uppy] = useState(() =>
    createPhotoUppy({
      shopId: shop.id,
      albumId,
      onBatchConfirmed: () => {
        void queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
        void queryClient.invalidateQueries({ queryKey: ['shops'] })
      },
      onOutcome: setOutcome,
    }),
  )
  useEffect(() => () => uppy.destroy(), [uppy])

  const remove = useMutation({
    mutationFn: (photoId: string) => api.deletePhoto(photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
    },
  })

  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const album = albums.data?.find((a) => a.id === albumId)

  const setStatus = useMutation({
    mutationFn: (status: AlbumStatus) => api.setAlbumStatus(shop.id, albumId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <Link to="/albums" className="text-sm text-brand hover:underline">
            ← Альбомы
          </Link>
          <h1 className="text-h1 font-semibold">{album?.title ?? 'Альбом'}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Три статуса: «по ссылке» не показывает альбом в списках витрины,
              но прямая ссылка работает — её можно разослать до публикации. */}
          <select
            value={album?.status ?? 'published'}
            onChange={(e) => setStatus.mutate(e.target.value as AlbumStatus)}
            disabled={!album || setStatus.isPending}
            className="rounded border border-line-strong px-2 py-2 text-sm"
            aria-label="Видимость альбома"
          >
            <option value="published">Опубликован</option>
            <option value="unlisted">По ссылке</option>
            <option value="draft">Черновик</option>
          </select>
          <Link
            to="/albums/$albumId/captions"
            params={{ albumId }}
            className="btn btn--primary"
          >
            Проставить подписи
          </Link>
        </div>
      </div>

      {outcome && (
        <div className="alert alert--warn">
          <span className="flex-1">
            Поместилось {outcome.uploaded} из {outcome.total}
            {outcome.reason ? `: ${outcome.reason}` : ''}.{' '}
            {outcome.reason && (
              <Link to="/billing" className="underline">
                Посмотреть тарифы
              </Link>
            )}
          </span>
          <button onClick={() => setOutcome(null)} aria-label="Закрыть">
            ×
          </button>
        </div>
      )}

      <div className="mb-6">
        <Dashboard uppy={uppy} height={260} proudlyDisplayPoweredByUppy={false} note="JPEG, PNG, WebP или HEIC, до 50 МБ" />
      </div>

      {photos.isPending && <p className="text-ink-2">Загрузка…</p>}
      {photos.isError && <p className="text-danger">Не удалось загрузить фото.</p>}

      {photos.data && photos.data.length === 0 && (
        <p className="text-ink-2">В альбоме пока нет фото — загрузите пачку выше.</p>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {photos.data?.map((p) => (
          <PhotoTile key={p.id} photo={p} onDelete={() => remove.mutate(p.id)} />
        ))}
      </div>
    </div>
  )
}

function PhotoTile({ photo, onDelete }: { photo: Photo; onDelete: () => void }) {
  return (
    <figure className="group relative overflow-hidden rounded-lg border border-line bg-white">
      <div className="aspect-square bg-surface-alt">
        {photo.status === 'ready' && photo.urls ? (
          <img
            src={photo.urls.thumb}
            srcSet={`${photo.urls.thumb} 300w, ${photo.urls.medium} 800w`}
            sizes="(max-width: 640px) 33vw, 20vw"
            alt={photo.caption || 'Фото'}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <StatusBadge status={photo.status} />
          </div>
        )}
      </div>
      {photo.caption && (
        <figcaption className="truncate px-2 py-1 text-xs text-ink-2">{photo.caption}</figcaption>
      )}
      <button
        onClick={onDelete}
        title="Удалить"
        className="absolute top-1 right-1 hidden rounded bg-black/60 px-1.5 py-0.5 text-xs text-white group-hover:block"
      >
        ✕
      </button>
    </figure>
  )
}

function StatusBadge({ status }: { status: Photo['status'] }) {
  if (status === 'processing' || status === 'uploading') {
    return (
      <span className="flex items-center gap-1 text-xs text-ink-2">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
        Обработка…
      </span>
    )
  }
  if (status === 'failed') {
    return <span className="text-xs font-medium text-danger">Ошибка файла</span>
  }
  return <span className="text-xs text-ink-2">{status}</span>
}
