import { Dashboard } from '@uppy/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorText, type AlbumStatus, type Photo } from '../api'
import { createPhotoUppy, type UploadOutcome } from '../lib/uppy'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { useShop } from './AppLayout'
import '@uppy/core/dist/style.min.css'
import '@uppy/dashboard/dist/style.min.css'

export function AlbumPage() {
  const shop = useShop()
  const { albumId } = useParams({ from: '/app/albums/$albumId' })
  const queryClient = useQueryClient()

  const [page, setPage] = useState(1)
  const photos = useQuery({
    queryKey: ['photos', shop.id, albumId, page],
    queryFn: () => api.listPhotos(shop.id, albumId, page),
    // Пока есть необработанные фото — опрашиваем статусы.
    refetchInterval: (query) =>
      query.state.data?.photos.some((p) => p.status === 'processing' || p.status === 'uploading')
        ? 2000
        : false,
  })

  // Счётчики квоты живут в двух запросах: мегабайты приходят из shops,
  // а число фотографий — из billing. Обновлять надо оба, иначе продавец
  // у лимита видит вчерашнее число и не понимает, почему загрузка встала.
  const refreshQuota = () => {
    void queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
  }

  const [outcome, setOutcome] = useState<UploadOutcome | null>(null)
  const [uppy] = useState(() =>
    createPhotoUppy({
      shopId: shop.id,
      albumId,
      onBatchConfirmed: refreshQuota,
      onOutcome: setOutcome,
    }),
  )
  useEffect(() => () => uppy.destroy(), [uppy])

  const remove = useMutation({
    mutationFn: (photoId: string) => api.deletePhoto(photoId),
    onSuccess: refreshQuota,
  })

  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const album = albums.data?.find((a) => a.id === albumId)
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })

  // Название и описание: описание показывается покупателю над фотографиями
  // и это единственное место, где продавец объясняет условия покупки.
  const [title, setTitle] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const titleValue = title ?? album?.title ?? ''
  const descValue = description ?? album?.description ?? ''
  const infoDirty = title !== null || description !== null
  useUnsavedGuard(infoDirty)

  const saveInfo = useMutation({
    mutationFn: () =>
      api.updateAlbum(shop.id, albumId, {
        ...(title !== null ? { title: titleValue.trim() } : {}),
        ...(description !== null ? { description: descValue } : {}),
      }),
    onSuccess: () => {
      setTitle(null)
      setDescription(null)
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  // Без этого категории оставались витриной без товара: создать их
  // продавец мог, а положить туда альбом — нет.
  const setCategory = useMutation({
    mutationFn: (categoryId: string | null) => api.setAlbumCategory(shop.id, albumId, categoryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  const setCover = useMutation({
    mutationFn: (photoId: string) =>
      api.updateAlbum(shop.id, albumId, { cover_photo_id: photoId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  const setStatus = useMutation({
    mutationFn: (status: AlbumStatus) => api.setAlbumStatus(shop.id, albumId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to="/albums" className="text-sm text-brand hover:underline">
            ← Альбомы
          </Link>
          <h1 className="text-h1 font-semibold">{album?.title ?? 'Альбом'}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Три статуса: «по ссылке» не показывает альбом в списках витрины,
              но прямая ссылка работает — её можно разослать до публикации. */}
          <select
            value={album?.status ?? 'published'}
            onChange={(e) => setStatus.mutate(e.target.value as AlbumStatus)}
            disabled={!album || setStatus.isPending}
            className="inp !w-auto"
            aria-label="Видимость альбома"
          >
            <option value="published">Опубликован</option>
            <option value="unlisted">По ссылке</option>
            <option value="draft">Черновик</option>
          </select>
          {/* Селект сам вернётся к прежнему значению, но молча: без текста
              продавец жмёт «Опубликован» ещё раз и не понимает, почему
              альбом остаётся черновиком. */}
          {setStatus.isError && (
            <p className="hint text-danger">{errorText(setStatus.error)}</p>
          )}
          <Link
            to="/albums/$albumId/captions"
            params={{ albumId }}
            className="btn btn--primary"
          >
            Проставить подписи
          </Link>
        </div>
      </div>

      {album?.blocked_by_moderator && (
        <div className="alert alert--warn">
          <span className="flex-1">
            Альбом скрыт с витрины модератором по жалобе. Статус переключать
            можно, но покупателям альбом не показывается. Если считаете
            блокировку ошибкой — напишите в поддержку.
          </span>
        </div>
      )}

      <section className="box">
        <label className="field">
          <span>Название альбома</span>
          <input
            className="inp"
            value={titleValue}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </label>
        <label className="field !mb-2">
          <span>Описание — покажется покупателю над фотографиями</span>
          <textarea
            className="inp"
            rows={3}
            value={descValue}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            placeholder="Размеры, цена, условия отправки"
          />
          <p className="hint">Переносы строк сохранятся.</p>
        </label>
        <label className="field">
          <span>Категория — по ней покупатель найдёт альбом в меню витрины</span>
          <select
            className="inp"
            value={album?.category_id ?? ''}
            onChange={(e) => setCategory.mutate(e.target.value || null)}
            disabled={!album || setCategory.isPending}
          >
            <option value="">Без категории</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          {categories.data?.length === 0 && (
            <p className="hint">
              Категорий пока нет — <Link to="/categories" className="underline">создайте первую</Link>.
            </p>
          )}
          {setCategory.isError && (
            <p className="hint text-danger">{errorText(setCategory.error)}</p>
          )}
        </label>
        {infoDirty && (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => saveInfo.mutate()}
            disabled={saveInfo.isPending || !titleValue.trim()}
          >
            {saveInfo.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
        )}
        {saveInfo.isError && <p className="hint text-danger">{errorText(saveInfo.error)}</p>}
      </section>

      {outcome && (
        <div className="alert alert--warn">
          <span className="flex-1">
            {outcome.confirmFailed
              ? `Не удалось подтвердить ${outcome.confirmFailed} из ${outcome.total} — файлы загружены, но обработка не начата. Загрузите их заново.`
              : `Поместилось ${outcome.uploaded} из ${outcome.total}${outcome.reason ? `: ${outcome.reason}` : ''}.`}{' '}
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
      {remove.isError && <p className="text-danger">{errorText(remove.error)}</p>}

      {photos.data && photos.data.total === 0 && (
        <p className="text-ink-2">В альбоме пока нет фото — загрузите пачку выше.</p>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {photos.data?.photos.map((p) => (
          <PhotoTile
            key={p.id}
            photo={p}
            isCover={album?.cover_photo_id === p.id}
            onSetCover={() => setCover.mutate(p.id)}
            onDelete={() => remove.mutate(p.id)}
          />
        ))}
      </div>

      {/* Пагинация: альбом может содержать тысячи фотографий, и грузить их
          одной страницей — несколько секунд пустых плиток. */}
      {photos.data && photos.data.total > photos.data.per_page && (
        <nav className="mt-4 flex items-center justify-center gap-3" aria-label="Страницы фотографий">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Назад
          </button>
          <span className="text-sm text-ink-2">
            {page} из {Math.ceil(photos.data.total / photos.data.per_page)}
          </span>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= Math.ceil(photos.data.total / photos.data.per_page)}
          >
            Дальше
          </button>
        </nav>
      )}
    </div>
  )
}

function PhotoTile({
  photo,
  onDelete,
  onSetCover,
  isCover,
}: {
  photo: Photo
  onDelete: () => void
  onSetCover: () => void
  isCover: boolean
}) {
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
      {/* Обложка — то, что покупатель видит в сетке альбомов. Без выбора
          ею всегда оказывалось первое загруженное фото. */}
      {photo.status === 'ready' && (
        <button
          onClick={onSetCover}
          title={isCover ? 'Это обложка альбома' : 'Сделать обложкой'}
          disabled={isCover}
          className="photo-tile__act absolute top-1 left-1 hidden rounded bg-black/60 px-1.5 py-0.5 text-xs text-white group-hover:block disabled:opacity-100"
        >
          {isCover ? '★' : '☆'}
        </button>
      )}
      <button
        onClick={onDelete}
        title="Удалить"
        className="photo-tile__act absolute top-1 right-1 hidden rounded bg-black/60 px-1.5 py-0.5 text-xs text-white group-hover:block"
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
