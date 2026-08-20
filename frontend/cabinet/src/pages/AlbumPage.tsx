import AwsS3 from '@uppy/aws-s3'
import Uppy from '@uppy/core'
import ru_RU from '@uppy/locales/lib/ru_RU'
import { Dashboard } from '@uppy/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, type AlbumStatus, type Photo } from '../api'
import { useShop } from './AppLayout'
import '@uppy/core/dist/style.min.css'
import '@uppy/dashboard/dist/style.min.css'

// createUppy: presign у API -> прямой PUT в S3 (не через бэкенд) ->
// batch-confirm по завершении. Ретраи при обрыве сети — кнопками Uppy.
function createUppy(shopId: string, albumId: string, onBatchConfirmed: () => void) {
  const uppy = new Uppy({
    locale: ru_RU,
    restrictions: {
      allowedFileTypes: ['image/*', '.heic', '.heif'],
      maxFileSize: 50 * 1024 * 1024,
    },
  }).use(AwsS3, {
    shouldUseMultipart: false,
    async getUploadParameters(file) {
      const { photo_id, url } = await api.presign(shopId, albumId, file.size ?? 0)
      uppy.setFileMeta(file.id, { photoId: photo_id })
      return { method: 'PUT', url, headers: {} }
    },
  })

  uppy.on('complete', (result) => {
    const ids = (result.successful ?? [])
      .map((f) => (f.meta as { photoId?: string }).photoId)
      .filter((id): id is string => Boolean(id))
    if (ids.length === 0) return
    void api.confirm(shopId, ids).then(onBatchConfirmed)
  })

  return uppy
}

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

  const [uppy] = useState(() =>
    createUppy(shop.id, albumId, () => {
      void queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
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
          <Link to="/" className="text-sm text-blue-600 hover:underline">
            ← Альбомы
          </Link>
          <h1 className="text-lg font-semibold text-gray-900">{album?.title ?? 'Альбом'}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Три статуса: «по ссылке» не показывает альбом в списках витрины,
              но прямая ссылка работает — её можно разослать до публикации. */}
          <select
            value={album?.status ?? 'published'}
            onChange={(e) => setStatus.mutate(e.target.value as AlbumStatus)}
            disabled={!album || setStatus.isPending}
            className="rounded border border-gray-300 px-2 py-2 text-sm"
            aria-label="Видимость альбома"
          >
            <option value="published">Опубликован</option>
            <option value="unlisted">По ссылке</option>
            <option value="draft">Черновик</option>
          </select>
          <Link
            to="/albums/$albumId/captions"
            params={{ albumId }}
            className="rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Проставить подписи
          </Link>
        </div>
      </div>

      <div className="mb-6">
        <Dashboard uppy={uppy} height={260} proudlyDisplayPoweredByUppy={false} note="JPEG, PNG, WebP или HEIC, до 50 МБ" />
      </div>

      {photos.isPending && <p className="text-gray-500">Загрузка…</p>}
      {photos.isError && <p className="text-red-600">Не удалось загрузить фото.</p>}

      {photos.data && photos.data.length === 0 && (
        <p className="text-gray-500">В альбоме пока нет фото — загрузите пачку выше.</p>
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
    <figure className="group relative overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="aspect-square bg-gray-100">
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
        <figcaption className="truncate px-2 py-1 text-xs text-gray-600">{photo.caption}</figcaption>
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
      <span className="flex items-center gap-1 text-xs text-gray-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
        Обработка…
      </span>
    )
  }
  if (status === 'failed') {
    return <span className="text-xs font-medium text-red-600">Ошибка файла</span>
  }
  return <span className="text-xs text-gray-500">{status}</span>
}
