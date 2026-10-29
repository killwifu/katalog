import { Check, Image as ImageIcon, Info, Minus, Trash2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorText, type TrashAlbum, type TrashPhoto } from '../api'
import { Icon } from '../lib/icons'
import { formatMB, plural } from '../lib/uploadRun'
import { useSegThumb } from '../lib/useSegThumb'
import { useShop } from './AppLayout'
import { ConfirmDialog } from './ConfirmDialog'
import { Toast } from './Toast'

// «Удаленное» по макету 20. Удалённое лежит здесь keep_days дней и всё это
// время занимает место в лимите тарифа — об этом плашка сверху: иначе
// продавец удаляет сотню фото, видит ту же цифру в квоте и считает это багом.
//
// «Вернуть» — сразу, «Удалить навсегда» и «Очистить» — через подтверждение
// с объёмом, который освободится. На тач-экранах наведения нет: чекбоксы
// видны всегда, отдельные фото возвращают и удаляют через выбор.

type Tab = 'all' | 'albums' | 'photos'
type Ask = { kind: 'album'; album: TrashAlbum } | { kind: 'photo'; photo: TrashPhoto } | { kind: 'picked' } | { kind: 'empty' }
type ToastState = { text: string; open?: string }

const DAY = 86_400_000
const albumsWord = (n: number) => `${n} ${plural(n, 'альбом', 'альбома', 'альбомов')}`

export function TrashPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [tab, setTab] = useState<Tab>('all')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [ask, setAsk] = useState<Ask | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [now] = useState(() => Date.now())
  const trash = useQuery({
    queryKey: ['trash', shop.id, page],
    queryFn: () => api.listTrash(shop.id, page),
  })
  // Подложку меряем, когда переключатель появился (после загрузки).
  const segRef = useSegThumb<HTMLDivElement>(`${tab}:${trash.isSuccess}:${picked.size > 0}`)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), toast.open ? 10000 : 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const refresh = () => {
    setPicked(new Set())
    void queryClient.invalidateQueries({ queryKey: ['trash', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['photos', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
  }

  // Одна мутация на все действия: и одиночные, и по выбору — это пачки
  // одних и тех же запросов, а итог всегда один тост.
  const run = useMutation({
    mutationFn: async (job: { albums: TrashAlbum[]; photos: TrashPhoto[]; purge: boolean; empty?: boolean }) => {
      if (job.empty) {
        await api.emptyTrash(shop.id)
        return { ...job, failed: 0 }
      }
      const calls = [
        ...job.albums.map((a) => (job.purge ? api.purgeAlbum(shop.id, a.id) : api.restoreAlbum(shop.id, a.id))),
        ...job.photos.map((p) => (job.purge ? api.purgePhoto(shop.id, p.id) : api.restorePhoto(shop.id, p.id))),
      ]
      const res = await Promise.allSettled(calls)
      return { ...job, failed: res.filter((r) => r.status === 'rejected').length }
    },
    onSuccess: (r) => {
      setAsk(null)
      if (r.empty) setPage(1)
      refresh()
      if (r.failed > 0) {
        setToast({ text: `Не удалось ${r.purge ? 'удалить' : 'вернуть'}: ${r.failed} из ${r.albums.length + r.photos.length}` })
        return
      }
      setToast(doneText(r, trash.data?.usage.bytes ?? 0))
    },
    onError: (e) => {
      setAsk(null)
      setToast({ text: `Не удалось очистить «Удаленное»: ${errorText(e)}` })
    },
  })

  if (trash.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (trash.isError) return <p className="text-danger" role="alert">Не удалось загрузить «Удаленное».</p>

  const data = trash.data
  const keep = data.keep_days
  const totalPages = Math.max(1, Math.ceil(data.total / data.per_page))
  const albums = data.albums ?? []
  const photos = data.photos
  const nothing = data.total === 0 && albums.length === 0
  const showAlbums = tab !== 'photos' && albums.length > 0
  const showPhotos = tab !== 'albums' && photos.length > 0
  const visible = [...(showAlbums ? albums.map((a) => 'a:' + a.id) : []), ...(showPhotos ? photos.map((p) => 'p:' + p.id) : [])]
  const pickedAlbums = albums.filter((a) => picked.has('a:' + a.id))
  const pickedPhotos = photos.filter((p) => picked.has('p:' + p.id))
  const pickedCount = pickedAlbums.length + pickedPhotos.length
  const allPicked = visible.length > 0 && visible.every((k) => picked.has(k))

  const daysLeft = (iso: string) => Math.max(0, keep - Math.floor((now - Date.parse(iso)) / DAY))
  const toggle = (key: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const busy = run.isPending

  const pickedWhat = [
    pickedAlbums.length > 0 && albumsWord(pickedAlbums.length),
    pickedPhotos.length > 0 && `${pickedPhotos.length} фото`,
  ]
    .filter(Boolean)
    .join(' и ')

  return (
    <div className="tr">
      <div className="tr__head">
        <div className="tr__title">
          <h1>Удаленное</h1>
          <p>
            Альбомы и фото хранятся здесь {keep} {plural(keep, 'день', 'дня', 'дней')}, потом удаляются навсегда. Пока они
            здесь, их можно вернуть — но они занимают место в хранилище.
          </p>
        </div>
        {!nothing && (
          <button className="tr__btn tr__btn--danger" onClick={() => setAsk({ kind: 'empty' })} disabled={busy}>
            <Icon as={Trash2} size={18} />
            Очистить «Удаленное»
          </button>
        )}
      </div>

      {nothing ? (
        <div className="tr__empty">
          <span className="tr__emptyico" aria-hidden="true">
            <Icon as={Trash2} size={28} />
          </span>
          <h2>В «Удаленном» пусто</h2>
          <p>
            Сюда попадают удалённые альбомы и фото. Их можно вернуть в течение {keep} {plural(keep, 'дня', 'дней', 'дней')},
            потом они удаляются навсегда.
          </p>
        </div>
      ) : (
        <>
          <p className="tr__banner">
            <Icon as={Info} size={18} />
            <span>
              Здесь {data.usage.photos} фото на {formatMB(data.usage.bytes)} — они учитываются в лимите тарифа. Чтобы
              освободить место, удалите их навсегда.
            </span>
          </p>

          {pickedCount > 0 ? (
            <div className="tr__sel">
              <button className="tr__check is-on" aria-label="Снять выделение" onClick={() => setPicked(new Set())}>
                <Icon as={allPicked ? Check : Minus} size={14} strokeWidth={3} />
              </button>
              <b>
                Выбрано {pickedCount}: {pickedWhat}
              </b>
              <span className="spacer" />
              <button className="tr__link" onClick={() => setPicked(new Set())}>
                Снять выделение
              </button>
              <button
                className="tr__btn"
                disabled={busy}
                onClick={() => run.mutate({ albums: pickedAlbums, photos: pickedPhotos, purge: false })}
              >
                Вернуть
              </button>
              <button className="tr__btn tr__btn--danger" disabled={busy} onClick={() => setAsk({ kind: 'picked' })}>
                <Icon as={Trash2} size={18} />
                Удалить навсегда
              </button>
            </div>
          ) : (
            <div className="tr__bar">
              <div className="seg seg--fit tr__seg" ref={segRef}>
                {(
                  [
                    ['all', 'Все', albums.length + data.total],
                    ['albums', 'Альбомы', albums.length],
                    ['photos', 'Фото', data.total],
                  ] as const
                ).map(([k, label, n]) => (
                  <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
                    {label} <em>{n}</em>
                  </button>
                ))}
              </div>
              <label className="tr__all">
                <input type="checkbox" checked={false} onChange={() => setPicked(new Set(visible))} />
                Выбрать всё
              </label>
            </div>
          )}

          {showAlbums && (
            <section className="tr__sec">
              <h2>
                Альбомы <em>{albums.length}</em>
              </h2>
              <div className="tr__albums">
                {albums.map((a) => {
                  const left = daysLeft(a.deleted_at)
                  const on = picked.has('a:' + a.id)
                  return (
                    <div key={a.id} className={`tralb${on ? ' is-on' : ''}`}>
                      <div className="tralb__cover">
                        {a.cover_urls ? (
                          <img src={a.cover_urls.small} alt="" loading="lazy" />
                        ) : (
                          <span className="tralb__none" aria-hidden="true">
                            <Icon as={ImageIcon} size={28} />
                          </span>
                        )}
                        <span className="tralb__count">{a.photos} фото</span>
                        <PickBox on={on} label={`Выбрать альбом «${a.title}»`} onToggle={() => toggle('a:' + a.id)} />
                      </div>
                      <div className="tralb__body">
                        <b title={a.title}>{a.title}</b>
                        <span className="tralb__meta">
                          Удалён {shortDate(a.deleted_at)} · {formatMB(a.bytes)}
                        </span>
                        <span className={`tralb__days${left <= 3 ? ' is-soon' : ''}`}>
                          {left <= 1 ? 'Удалится завтра' : `Удалится через ${left} ${plural(left, 'день', 'дня', 'дней')}`}
                        </span>
                        <span className="tralb__acts">
                          <button
                            className="tr__btn tr__btn--sm"
                            disabled={busy}
                            onClick={() => run.mutate({ albums: [a], photos: [], purge: false })}
                          >
                            Вернуть
                          </button>
                          <button
                            className="tr__ico"
                            aria-label={`Удалить альбом «${a.title}» навсегда`}
                            disabled={busy}
                            onClick={() => setAsk({ kind: 'album', album: a })}
                          >
                            <Icon as={Trash2} size={18} />
                          </button>
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {showPhotos && (
            <section className="tr__sec">
              <h2>
                Отдельные фото <em>{data.total}</em>
              </h2>
              <p className="tr__hint">Фото, удалённые из альбомов. «Вернуть» — фото вернётся в свой альбом.</p>
              <div className="tr__photos">
                {photos.map((p) => {
                  const left = daysLeft(p.deleted_at)
                  const on = picked.has('p:' + p.id)
                  return (
                    <figure key={p.id} className={`trph${on ? ' is-on' : ''}${pickedCount > 0 ? ' is-picking' : ''}`}>
                      <div className="trph__img">
                        {p.urls ? (
                          <img src={p.urls.small} alt={p.caption || 'Удалённое фото'} loading="lazy" />
                        ) : (
                          <span className="tralb__none">Без превью</span>
                        )}
                        <span className={`trph__days${left <= 3 ? ' is-soon' : ''}`}>
                          {left <= 1 ? 'завтра' : `${left} ${plural(left, 'день', 'дня', 'дней')}`}
                        </span>
                        <PickBox on={on} label="Выбрать фото" onToggle={() => toggle('p:' + p.id)} />
                        <span className="trph__acts">
                          <button disabled={busy} onClick={() => run.mutate({ albums: [], photos: [p], purge: false })}>
                            Вернуть
                          </button>
                          <button
                            className="trph__del"
                            aria-label="Удалить фото навсегда"
                            disabled={busy}
                            onClick={() => setAsk({ kind: 'photo', photo: p })}
                          >
                            <Icon as={Trash2} size={18} />
                          </button>
                        </span>
                      </div>
                      <figcaption title={p.album_title}>из «{p.album_title}»</figcaption>
                    </figure>
                  )
                })}
              </div>
            </section>
          )}

          {totalPages > 1 && tab !== 'albums' && (
            <nav className="mt-4 flex items-center justify-center gap-3" aria-label="Страницы">
              <button className="tr__btn tr__btn--sm" onClick={() => setPage((v) => Math.max(1, v - 1))} disabled={page === 1}>
                Назад
              </button>
              <span className="text-sm text-ink-2">
                {page} из {totalPages}
              </span>
              <button className="tr__btn tr__btn--sm" onClick={() => setPage((v) => v + 1)} disabled={page >= totalPages}>
                Дальше
              </button>
            </nav>
          )}
        </>
      )}

      {ask && (
        <ConfirmDialog
          {...askText(ask, { albums, total: data.total, usage: data.usage, pickedAlbums, pickedPhotos })}
          icon="trash"
          danger
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            if (busy) return
            if (ask.kind === 'empty') run.mutate({ albums, photos: [], purge: true, empty: true })
            else if (ask.kind === 'album') run.mutate({ albums: [ask.album], photos: [], purge: true })
            else if (ask.kind === 'photo') run.mutate({ albums: [], photos: [ask.photo], purge: true })
            else run.mutate({ albums: pickedAlbums, photos: pickedPhotos, purge: true })
          }}
        />
      )}

      {toast && (
        <div className="al__toast">
          <Toast
            text={toast.text}
            actions={
              toast.open
                ? [{ label: 'Открыть', run: () => void navigate({ to: '/albums/$albumId', params: { albumId: toast.open! } }) }]
                : []
            }
            onClose={() => setToast(null)}
          />
        </div>
      )}
    </div>
  )
}

// Чекбокс на карточке: на Desktop — по наведению или когда что-то выбрано,
// на тач-экранах — всегда (CSS).
function PickBox({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button className={`tr__check tr__pick${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={label} onClick={onToggle}>
      {on && <Icon as={Check} size={14} strokeWidth={3} />}
    </button>
  )
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
}

const sumBytes = (albums: TrashAlbum[], photos: TrashPhoto[]) =>
  albums.reduce((n, a) => n + a.bytes, 0) + photos.reduce((n, p) => n + p.bytes, 0)

function askText(
  ask: Ask,
  d: {
    albums: TrashAlbum[]
    total: number
    usage: { photos: number; bytes: number }
    pickedAlbums: TrashAlbum[]
    pickedPhotos: TrashPhoto[]
  },
): { title: string; text: string; confirmLabel: string } {
  if (ask.kind === 'empty') {
    const parts = [d.albums.length > 0 && albumsWord(d.albums.length), d.total > 0 && `${d.total} отдельных фото`].filter(Boolean)
    return {
      title: 'Очистить «Удаленное»?',
      text: `${parts.join(' и ')} — всего ${d.usage.photos} фото — удалятся навсегда. Вернуть их будет нельзя. Освободится ${formatMB(d.usage.bytes)}.`,
      confirmLabel: 'Очистить навсегда',
    }
  }
  if (ask.kind === 'album') {
    const a = ask.album
    return {
      title: `Удалить альбом «${a.title}» навсегда?`,
      text: `Альбом и ${a.photos} фото в нём удалятся без возможности восстановления. Освободится ${formatMB(a.bytes)}.`,
      confirmLabel: 'Удалить навсегда',
    }
  }
  if (ask.kind === 'photo') {
    return {
      title: 'Удалить фото навсегда?',
      text: `Фото из «${ask.photo.album_title}» удалится без возможности восстановления. Освободится ${formatMB(ask.photo.bytes)}.`,
      confirmLabel: 'Удалить навсегда',
    }
  }
  const what = [d.pickedAlbums.length > 0 && albumsWord(d.pickedAlbums.length), d.pickedPhotos.length > 0 && `${d.pickedPhotos.length} фото`]
    .filter(Boolean)
    .join(' и ')
  return {
    title: `Удалить навсегда: ${what}?`,
    text: `Выбранное удалится без возможности восстановления. Освободится ${formatMB(sumBytes(d.pickedAlbums, d.pickedPhotos))}.`,
    confirmLabel: 'Удалить навсегда',
  }
}

function doneText(r: { albums: TrashAlbum[]; photos: TrashPhoto[]; purge: boolean; empty?: boolean }, allBytes: number): ToastState {
  if (r.empty) return { text: `«Удаленное» очищено · освободилось ${formatMB(allBytes)}` }
  const freed = ` · освободилось ${formatMB(sumBytes(r.albums, r.photos))}`
  if (r.albums.length === 1 && r.photos.length === 0) {
    const a = r.albums[0]
    return r.purge
      ? { text: `Альбом «${a.title}» удалён навсегда${freed}` }
      : { text: `Альбом «${a.title}» восстановлен`, open: a.id }
  }
  if (r.albums.length === 0 && r.photos.length === 1) {
    const p = r.photos[0]
    return r.purge
      ? { text: `Фото удалено навсегда${freed}` }
      : { text: `Фото возвращено в «${p.album_title}»`, open: p.album_id }
  }
  const what = [r.albums.length > 0 && albumsWord(r.albums.length), r.photos.length > 0 && `${r.photos.length} фото`]
    .filter(Boolean)
    .join(' и ')
  return { text: r.purge ? `Удалено навсегда: ${what}${freed}` : `Восстановлено: ${what}` }
}
