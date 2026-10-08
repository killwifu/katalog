import { Trash2, Image as ImageIcon } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, errorText, type Photo, type TrashAlbum } from '../api'
import { Icon } from '../lib/icons'
import { useShop } from './AppLayout'

// «Удаленное» из макета 09 · v2. Удаление фотографии перестало быть
// необратимым: промах по крестику на плитке стоил продавцу снимка навсегда.
//
// Место в хранилище удалённое продолжает занимать — файлы лежат в S3 до
// окончательной уборки. Об этом сказано прямо на странице: иначе продавец
// удаляет сотню фотографий, видит ту же цифру в квоте и считает это багом.
export function TrashPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  const trash = useQuery({
    queryKey: ['trash', shop.id, page],
    queryFn: () => api.listTrash(shop.id, page),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['trash', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['photos', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
  }

  const restore = useMutation({
    mutationFn: (photoId: string) => api.restorePhoto(shop.id, photoId),
    onSuccess: refresh,
  })
  const purge = useMutation({
    mutationFn: (photoId: string) => api.purgePhoto(shop.id, photoId),
    onSuccess: refresh,
  })
  const restoreAlbum = useMutation({
    mutationFn: (albumId: string) => api.restoreAlbum(shop.id, albumId),
    onSuccess: refresh,
  })
  const purgeAlbum = useMutation({
    mutationFn: (albumId: string) => api.purgeAlbum(shop.id, albumId),
    onSuccess: refresh,
  })
  const empty = useMutation({
    mutationFn: () => api.emptyTrash(shop.id),
    onSuccess: () => {
      setConfirmEmpty(false)
      setPage(1)
      refresh()
    },
  })

  if (trash.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (trash.isError) return <p className="text-danger" role="alert">Не удалось загрузить «Удаленное».</p>

  const data = trash.data
  const totalPages = Math.max(1, Math.ceil(data.total / data.per_page))
  const albums = data.albums ?? []
  const nothing = data.total === 0 && albums.length === 0

  return (
    <div>
      <div className="page__head">
        <h1>Удаленное</h1>
        <span className="count">{data.total + albums.length}</span>
        <span className="spacer" />
        {!nothing &&
          (confirmEmpty ? (
            <>
              <span className="text-sm text-danger">Удалить всё безвозвратно?</span>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirmEmpty(false)}>
                Отмена
              </button>
              <button
                className="btn btn--danger btn--sm"
                onClick={() => empty.mutate()}
                disabled={empty.isPending}
              >
                Очистить
              </button>
            </>
          ) : (
            <button className="btn btn--ghost btn--sm" onClick={() => setConfirmEmpty(true)}>
              Очистить корзину
            </button>
          ))}
      </div>
      <p className="page__lead">
        Альбомы и фотографии хранятся здесь {data.keep_days}{' '}
        {plural(data.keep_days, 'день', 'дня', 'дней')}, потом удаляются
        окончательно. Всё это время они занимают место в хранилище — освободит
        его только окончательное удаление.
      </p>

      {restore.isError && <p className="mb-3 text-sm text-danger" role="alert">{errorText(restore.error)}</p>}
      {purge.isError && <p className="mb-3 text-sm text-danger" role="alert">{errorText(purge.error)}</p>}
      {empty.isError && <p className="mb-3 text-sm text-danger" role="alert">{errorText(empty.error)}</p>}
      {restoreAlbum.isError && <p className="mb-3 text-sm text-danger" role="alert">{errorText(restoreAlbum.error)}</p>}
      {purgeAlbum.isError && <p className="mb-3 text-sm text-danger" role="alert">{errorText(purgeAlbum.error)}</p>}

      {albums.length > 0 && (
        <>
          <h2 className="trash__h">Альбомы</h2>
          <div className="algrid mb-6">
            {albums.map((a) => (
              <TrashAlbumCard
                key={a.id}
                album={a}
                onRestore={() => restoreAlbum.mutate(a.id)}
                onPurge={() => purgeAlbum.mutate(a.id)}
              />
            ))}
          </div>
          {data.total > 0 && <h2 className="trash__h">Фотографии</h2>}
        </>
      )}

      {nothing ? (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">
            <Icon as={Trash2} size={28} />
          </div>
          <h2>Здесь пусто</h2>
          <p>Удалённые альбомы и фотографии попадают сюда и ждут {data.keep_days} {plural(data.keep_days, 'день', 'дня', 'дней')} — их можно вернуть.</p>
        </div>
      ) : (
        <div className="algallery">
          {data.photos.map((p) => (
            <TrashTile
              key={p.id}
              photo={p}
              onRestore={() => restore.mutate(p.id)}
              onPurge={() => purge.mutate(p.id)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-3" aria-label="Страницы">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setPage((v) => Math.max(1, v - 1))}
            disabled={page === 1}
          >
            Назад
          </button>
          <span className="text-sm text-ink-2">
            {page} из {totalPages}
          </span>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setPage((v) => v + 1)}
            disabled={page >= totalPages}
          >
            Дальше
          </button>
        </nav>
      )}
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function TrashTile({
  photo,
  onRestore,
  onPurge,
}: {
  photo: Photo
  onRestore: () => void
  onPurge: () => void
}) {
  const [armed, setArmed] = useState(false)
  return (
    <figure className="relative overflow-hidden rounded-lg border border-line bg-white">
      <div className="aspect-square bg-surface-alt">
        {photo.urls ? (
          <img
            src={photo.urls.small}
            alt={photo.caption || 'Удалённое фото'}
            loading="lazy"
            className="h-full w-full object-cover opacity-70"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-ink-3">
            Без превью
          </div>
        )}
      </div>
      {photo.caption && (
        <figcaption className="truncate px-2 py-1 text-xs text-ink-2">{photo.caption}</figcaption>
      )}
      <TrashActions armed={armed} onRestore={onRestore} onPurge={() => (armed ? onPurge() : setArmed(true))} />
    </figure>
  )
}

// Удалённый альбом: одной карточкой вместе со всеми фотографиями.
function TrashAlbumCard({
  album,
  onRestore,
  onPurge,
}: {
  album: TrashAlbum
  onRestore: () => void
  onPurge: () => void
}) {
  const [armed, setArmed] = useState(false)
  return (
    <div className="alcard">
      <div className="alcard__cover">
        {album.cover_urls ? (
          <img src={album.cover_urls.small} alt="" loading="lazy" className="opacity-70" />
        ) : (
          <span className="alcard__cover--empty" aria-hidden="true">
            <Icon as={ImageIcon} size={28} />
          </span>
        )}
        <span className="alcard__count">{album.photo_count} фото</span>
      </div>
      <div className="alcard__body">
        <b title={album.title}>{album.title}</b>
        <span className="alcard__cat">удалён {new Date(album.deleted_at).toLocaleDateString('ru-RU')}</span>
        <TrashActions armed={armed} onRestore={onRestore} onPurge={() => (armed ? onPurge() : setArmed(true))} />
      </div>
    </div>
  )
}

// Действия на плитке «Удаленного»: две одинаковые кнопки в ряд — раньше
// «Вернуть» была кнопкой, а «Удалить» голым текстом другого размера.
// Второй шаг обязателен: отсюда фото и альбомы уходят навсегда.
function TrashActions({ armed, onRestore, onPurge }: { armed: boolean; onRestore: () => void; onPurge: () => void }) {
  return (
    <div className="tracts">
      {!armed && (
        <button className="tracts__btn" onClick={onRestore}>
          Вернуть
        </button>
      )}
      <button className={armed ? 'tracts__btn tracts__btn--armed' : 'tracts__btn tracts__btn--danger'} onClick={onPurge}>
        {armed && <Icon as={Trash2} size={14} />}
        {armed ? 'Точно удалить?' : 'Удалить'}
      </button>
    </div>
  )
}
