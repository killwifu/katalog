import { Dashboard } from '@uppy/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorText, type Photo } from '../api'
import { createPhotoUppy, type UploadOutcome } from '../lib/uppy'
import { useShop } from './AppLayout'
import { EditAlbumDialog } from './EditAlbumDialog'
import '@uppy/core/dist/style.min.css'
import '@uppy/dashboard/dist/style.min.css'

// Страница альбома по макету 13 · Desktop · v2. Шапка отвечает «что это за
// альбом и что с ним делать», ниже сразу фотографии: правка названия и
// описания уехала в окно (макет 12), чтобы форма не отжимала сетку вниз.
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

  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const album = albums.data?.find((a) => a.id === albumId)
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })
  const stats = useQuery({ queryKey: ['stats', shop.id, 14], queryFn: () => api.getStats(shop.id, 14) })

  const [editing, setEditing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  const totalPages = photos.data
    ? Math.max(1, Math.ceil(photos.data.total / photos.data.per_page))
    : 1

  const remove = useMutation({
    mutationFn: (photoId: string) => api.deletePhoto(photoId),
    onSuccess: () => {
      // Удаление последнего фото на странице оставляло продавца на странице,
      // которой больше нет: сетка пустая, а навигация исчезает вместе с ней,
      // когда фото стало меньше одной страницы.
      if (page > 1 && photos.data?.photos.length === 1) setPage((p) => p - 1)
      refreshQuota()
    },
  })

  const setCover = useMutation({
    mutationFn: (photoId: string) => api.updateAlbum(shop.id, albumId, { cover_photo_id: photoId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] }),
  })

  const shown = photos.data?.photos ?? []
  const allPicked = shown.length > 0 && shown.every((p) => picked.has(p.id))
  const toggleAll = () => {
    const next = new Set(picked)
    for (const p of shown) {
      if (allPicked) next.delete(p.id)
      else next.add(p.id)
    }
    setPicked(next)
  }
  const removePicked = async () => {
    for (const id of picked) await api.deletePhoto(id)
    setPicked(new Set())
    refreshQuota()
  }

  const albumUrl = `${location.origin}/${shop.slug}/a/${albumId}`
  const share = async () => {
    try {
      await navigator.clipboard.writeText(albumUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* буфер недоступен — ссылка остаётся видимой в адресе альбома */
    }
  }

  const views = stats.data?.top_albums.find((a) => a.album_id === albumId)?.views
  const watermark = shop.settings.watermark
  const category = album?.category_id
    ? categories.data?.find((c) => c.id === album.category_id)?.title
    : undefined

  return (
    <div>
      <nav className="alpage__crumbs">
        <Link to="/albums">‹ Альбомы</Link>
        <span>/</span>
        <span>{album?.title ?? 'Альбом'}</span>
      </nav>

      <div className="alpage__top">
        <h1>{album?.title ?? 'Альбом'}</h1>
        {album && <span className={STATUS[album.status].cls}>{STATUS[album.status].label}</span>}
        {album?.blocked_by_moderator && <span className="badge badge--warn">Скрыт модератором</span>}
        <span className="spacer" />
        <button className="btn btn--ghost btn--sm" onClick={() => void share()}>
          {copied ? 'Скопировано' : 'Поделиться'}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setEditing(true)} disabled={!album}>
          Редактировать
        </button>
        <button className="btn btn--primary btn--sm" onClick={() => setUploading((v) => !v)}>
          Загрузить фото
        </button>
        <Link to="/albums/$albumId/captions" params={{ albumId }} className="btn btn--ghost btn--sm">
          Подписи
        </Link>
      </div>

      <p className="alpage__meta">
        {[
          category ?? 'Без категории',
          `${album?.photo_count ?? 0} фото`,
          album?.created_at ? `создан ${dateRu(album.created_at)}` : null,
          album?.updated_at ? `обновлён ${dateRu(album.updated_at)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {album?.description && <p className="alpage__desc">{album.description}</p>}

      {album?.blocked_by_moderator && (
        <div className="alert alert--warn">
          <span className="flex-1">
            Альбом скрыт с витрины модератором по жалобе. Статус переключать
            можно, но покупателям альбом не показывается. Если считаете
            блокировку ошибкой — напишите в поддержку.
          </span>
        </div>
      )}

      <div className="alstats">
        <div className="alstat">
          <span>Просмотры за 7 дней</span>
          {views === undefined ? (
            <em>нет данных за период</em>
          ) : (
            <b>{views.toLocaleString('ru-RU')}</b>
          )}
        </div>
        <div className="alstat">
          <span>Водяной знак</span>
          <b style={{ fontSize: 22 }}>{watermark?.enabled ? 'Включён' : 'Выключен'}</b>
          <Link to="/settings" className="ml-2 text-sm font-medium text-brand">
            Настроить
          </Link>
        </div>
      </div>

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

      {uploading && (
        <div className="mb-6">
          <Dashboard uppy={uppy} height={260} proudlyDisplayPoweredByUppy={false} note="JPEG, PNG, WebP или HEIC, до 50 МБ" />
        </div>
      )}

      <div className="alhead">
        <label>
          <input type="checkbox" checked={allPicked} onChange={toggleAll} disabled={shown.length === 0} />
          Выбрать все
        </label>
        {picked.size > 0 && (
          <>
            <span>Выбрано: {picked.size}</span>
            <button className="btn btn--danger btn--sm" onClick={() => void removePicked()}>
              Удалить выбранные
            </button>
          </>
        )}
        <span className="spacer" />
        {photos.data && <span>{photos.data.total} фото</span>}
      </div>

      {photos.isPending && <p className="text-ink-2">Загрузка…</p>}
      {photos.isError && <p className="text-danger">Не удалось загрузить фото.</p>}
      {remove.isError && <p className="text-danger">{errorText(remove.error)}</p>}
      {setCover.isError && <p className="text-danger">{errorText(setCover.error)}</p>}

      <div className="algallery">
        {/* Плитка загрузки — первой в сетке, как в макете. */}
        <button className="uptile" onClick={() => setUploading(true)}>
          <i aria-hidden="true">＋</i>
          <span>Загрузить фото</span>
          <small>или перетащите сюда</small>
        </button>
        {shown.map((p) => (
          <PhotoTile
            key={p.id}
            photo={p}
            isCover={album?.cover_photo_id === p.id}
            picked={picked.has(p.id)}
            onPick={() => {
              const next = new Set(picked)
              if (next.has(p.id)) next.delete(p.id)
              else next.add(p.id)
              setPicked(next)
            }}
            onSetCover={() => setCover.mutate(p.id)}
            onDelete={() => remove.mutate(p.id)}
          />
        ))}
      </div>

      {/* Пагинация: альбом может содержать тысячи фотографий, и грузить их
          одной страницей — несколько секунд пустых плиток. */}
      {photos.data && (photos.data.total > photos.data.per_page || page > 1) && (
        <nav className="mt-4 flex items-center justify-center gap-3" aria-label="Страницы фотографий">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Назад
          </button>
          <span className="text-sm text-ink-2">
            {page} из {totalPages}
          </span>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages}
          >
            Дальше
          </button>
        </nav>
      )}

      {editing && album && (
        <EditAlbumDialog
          shopId={shop.id}
          album={album}
          categories={categories.data ?? []}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

const STATUS = {
  published: { label: 'Опубликован', cls: 'badge badge--live' },
  unlisted: { label: 'По ссылке', cls: 'badge badge--link' },
  draft: { label: 'Черновик', cls: 'badge badge--draft' },
} as const

function dateRu(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

function PhotoTile({
  photo,
  onDelete,
  onSetCover,
  onPick,
  isCover,
  picked,
}: {
  photo: Photo
  onDelete: () => void
  onSetCover: () => void
  onPick: () => void
  isCover: boolean
  picked: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <figure className="group relative overflow-hidden rounded-lg border border-line bg-white">
      <input
        type="checkbox"
        className="alcard__pick"
        checked={picked}
        onChange={onPick}
        aria-label="Выбрать фото"
      />
      <div className="aspect-square bg-surface-alt">
        {photo.status === 'ready' && photo.urls ? (
          <img
            src={photo.urls.small}
            srcSet={`${photo.urls.small} 500w, ${photo.urls.medium} 800w`}
            sizes="(max-width: 640px) 33vw, 20vw"
            alt={photo.caption || 'Фото'}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <StatusBadge status={photo.status} reason={photo.fail_reason} />
          </div>
        )}
      </div>
      {photo.caption && (
        <figcaption className="truncate px-2 py-1 text-xs text-ink-2">{photo.caption}</figcaption>
      )}
      {/* Обложка — то, что покупатель видит в сетке альбомов. Без выбора
          ею всегда оказывалось первое загруженное фото. */}
      {photo.status === 'ready' &&
        (isCover ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
            Обложка
          </span>
        ) : (
          <button
            onClick={onSetCover}
            className="photo-tile__act absolute bottom-1 left-1 hidden rounded bg-black/60 px-1.5 py-0.5 text-xs text-white group-hover:block"
          >
            Сделать обложкой
          </button>
        ))}
      {/* Два тапа, не один: на телефоне кнопка видна всегда (наводить нечем),
          а промах по ней стоил фотографии — восстановить её нельзя.
          Взвод сам спадает через три секунды, чтобы красный крест
          не оставался висеть на плитке. */}
      <button
        onClick={() => (armed ? onDelete() : setArmed(true))}
        title={armed ? 'Нажмите ещё раз, чтобы удалить' : 'Удалить'}
        className={`photo-tile__act absolute top-1 right-1 hidden rounded px-1.5 py-0.5 text-xs text-white group-hover:block ${
          armed ? 'bg-danger font-medium' : 'bg-black/60'
        }`}
      >
        {armed ? 'Удалить?' : '✕'}
      </button>
    </figure>
  )
}

// Что показать продавцу вместо кода. Причина нужна ровно для того, чтобы
// он понял, что чинить: в пачке из трёхсот снимков «ошибка файла» на всех
// одинаковая и бесполезная.
const FAIL_TEXT: Record<string, string> = {
  unsupported_format: 'Формат не поддерживается',
  corrupt: 'Файл повреждён',
  too_large: 'Слишком большое разрешение',
  empty: 'Пустой файл',
  // Не про файл, а про нас: задача обработки потерялась. Винить в этом
  // фотографию продавца нельзя — он начнёт искать проблему там, где её нет.
  lost: 'Обработка не завершилась — загрузите файл заново',
}

function StatusBadge({ status, reason }: { status: Photo['status']; reason?: string }) {
  if (status === 'processing' || status === 'uploading') {
    return (
      <span className="flex items-center gap-1 text-xs text-ink-2">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
        Обработка…
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="text-xs font-medium text-danger" title={FAIL_TEXT[reason ?? ''] ?? 'Причина неизвестна'}>
        {FAIL_TEXT[reason ?? ''] ?? 'Не удалось обработать'}
      </span>
    )
  }
  if (status === 'blocked') {
    return <span className="text-xs font-medium text-danger">Скрыто модератором</span>
  }
  // Осталось только ready без готовых деривативов: файл принят, ссылок ещё нет.
  return <span className="text-xs text-ink-2">Готовим…</span>
}
