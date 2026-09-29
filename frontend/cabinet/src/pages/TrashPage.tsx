import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, errorText, type Photo } from '../api'
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
  const empty = useMutation({
    mutationFn: () => api.emptyTrash(shop.id),
    onSuccess: () => {
      setConfirmEmpty(false)
      setPage(1)
      refresh()
    },
  })

  if (trash.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (trash.isError) return <p className="text-danger">Не удалось загрузить «Удаленное».</p>

  const data = trash.data
  const totalPages = Math.max(1, Math.ceil(data.total / data.per_page))

  return (
    <div>
      <div className="page__head">
        <h1>Удаленное</h1>
        <span className="count">{data.total}</span>
        <span className="spacer" />
        {data.total > 0 &&
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
        Фотографии хранятся здесь {data.keep_days}{' '}
        {plural(data.keep_days, 'день', 'дня', 'дней')}, потом удаляются
        окончательно. Всё это время они занимают место в хранилище — освободит
        его только окончательное удаление.
      </p>

      {restore.isError && <p className="mb-3 text-sm text-danger">{errorText(restore.error)}</p>}
      {purge.isError && <p className="mb-3 text-sm text-danger">{errorText(purge.error)}</p>}
      {empty.isError && <p className="mb-3 text-sm text-danger">{errorText(empty.error)}</p>}

      {data.total === 0 ? (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">🗑</div>
          <h3>Здесь пусто</h3>
          <p>Удалённые фотографии попадают сюда и ждут {data.keep_days} дней — их можно вернуть.</p>
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2">
        <button className="btn btn--ghost btn--sm" onClick={onRestore}>
          Вернуть
        </button>
        {/* Второй шаг обязателен: отсюда фотография уходит уже навсегда. */}
        <button
          className={`text-xs ${armed ? 'font-medium text-danger' : 'text-ink-2 hover:text-danger'}`}
          onClick={() => (armed ? onPurge() : setArmed(true))}
        >
          {armed ? 'Точно удалить?' : 'Удалить'}
        </button>
      </div>
    </figure>
  )
}
