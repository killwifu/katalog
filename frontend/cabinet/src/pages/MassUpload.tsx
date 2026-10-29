import { Check, CircleAlert, X, Folder, FolderPlus, Pen, Upload } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MutableRefObject } from 'react'
import { api, ApiError, errorText, type Category, type Shop } from '../api'
import { Icon } from '../lib/icons'
import { foldersFromDrop, foldersFromInput, type PickedFolder } from '../lib/folders'
import { FORMATS_HINT, formatMB, plural, uploadToAlbum } from '../lib/uploadRun'
import { CategoryPicker } from './CategoryPicker'
import { ConfirmDialog } from './ConfirmDialog'
import { LimitError, LimitLink, useLimitExcess } from '../lib/limits'
import { WatermarkControl } from './WatermarkControl'
import { useSingleFlight } from '../lib/singleFlight'

// Массовая загрузка по макету 10 · Desktop · v2: каждая папка с компьютера
// становится альбомом с её названием.
//
// В макете альбомы «создаются» последней кнопкой, уже после загрузки фото.
// Пайплайн так не умеет: presign просит album_id, грузить фото в никуда
// нельзя. Поэтому альбом заводится черновиком в момент, когда до его папки
// доходит очередь, а последняя кнопка публикует черновики и сохраняет
// поправленные названия. Покупатель не видит полупустых альбомов, а
// закрытие без сохранения убирает черновики за собой.
const MAX_TITLE = 30

type Folder = PickedFolder & {
  id: string
  title: string
  // Категории будущего альбома — можно несколько (макет 10).
  categoryIds: string[]
  albumId?: string
  // Название, с которым альбом создан: менять его на сервере нужно,
  // только если продавец поправил его после загрузки.
  savedTitle?: string
  // Индексы файлов, уже лежащих в альбоме: после остановки или сбоя сети
  // догружаем остальное, а не всю папку заново.
  sent: Set<number>
  percent: number
  error?: string
}

type Phase = 'pick' | 'uploading' | 'paused' | 'review' | 'saving'

const canPickFolders = typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input')

export function MassUpload({
  shop,
  categories,
  onClose,
  onLock,
  closeRef,
}: {
  shop: Shop
  categories: Category[]
  onClose: (done?: string) => void
  onLock: (locked: boolean) => void
  closeRef: MutableRefObject<() => void>
}) {
  const queryClient = useQueryClient()
  const dirInput = useRef<HTMLInputElement>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [over, setOver] = useState(false)
  // Сколько папок тащат — для «Отпустите, чтобы добавить 5 папок».
  const [dragCount, setDragCount] = useState(0)
  // На сколько папки превышают тариф — ошибка до загрузки (макет 10 · «Массовая · Лимит фото»).
  const [overLimit, setOverLimit] = useState('')
  const [phase, setPhase] = useState<Phase>('pick')
  const [confirm, setConfirm] = useState<'no' | 'clear' | 'close'>('no')
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  // Актуальный список для цикла загрузки: он живёт дольше одного рендера.
  const live = useRef<Folder[]>([])
  useEffect(() => {
    live.current = folders
  }, [folders])

  // Сначала ref, потом состояние: цикл загрузки читает список сразу после
  // правки, не дожидаясь рендера.
  const patch = (id: string, next: Partial<Folder>) => {
    live.current = live.current.map((f) => (f.id === id ? { ...f, ...next } : f))
    setFolders(live.current)
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
  }

  const add = (picked: PickedFolder[]) => {
    setFolders((prev) => [
      ...prev,
      ...picked.map((p) => ({
        ...p,
        id: crypto.randomUUID(),
        title: p.name,
        categoryIds: [],
        sent: new Set<number>(),
        percent: 0,
      })),
    ])
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (phase !== 'pick') return
    void foldersFromDrop(e.dataTransfer.items).then(add)
  }
  const dragOver = (e: DragEvent) => {
    e.preventDefault()
    setOver(true)
    setDragCount([...e.dataTransfer.items].filter((i) => i.kind === 'file').length)
  }
  const foldersWord = (n: number) => plural(n, 'папку', 'папки', 'папок')
  const release = `Отпустите, чтобы добавить ${dragCount > 0 ? `${dragCount} ${foldersWord(dragCount)}` : 'папки'}`

  // Убрать папку можно и после загрузки: её черновик удаляется вместе с ней.
  const removeFolder = (f: Folder) => {
    setFolders((prev) => prev.filter((x) => x.id !== f.id))
    if (f.albumId) void api.deleteAlbum(shop.id, f.albumId).then(refresh, refresh)
  }

  // Пустая папка альбомом не станет, её не считаем и не грузим.
  const usable = folders.filter((f) => f.files.length > 0)
  const titleBad = (f: Folder) => f.title.trim() === '' || f.title.trim().length > MAX_TITLE
  const invalid = usable.some(titleBad)
  const photos = usable.reduce((sum, f) => sum + f.files.length, 0)
  const bytes = usable.reduce((sum, f) => sum + f.bytes, 0)
  const complete = (f: Folder) => f.sent.size === f.files.length
  const doneFolders = usable.filter(complete).length
  const sentPhotos = usable.reduce((sum, f) => sum + f.sent.size, 0)
  const created = folders.filter((f) => f.albumId)
  const albumsWord = (n: number) => plural(n, 'альбом', 'альбома', 'альбомов')

  const discard = async () => {
    // Черновики, заведённые под загрузку, без подтверждения не нужны:
    // иначе в списке альбомов остались бы обрывки отменённой загрузки.
    await Promise.allSettled(created.map((f) => api.deleteAlbum(shop.id, f.albumId as string)))
    refresh()
    onClose()
  }

  const close = () => {
    if (phase === 'uploading' || phase === 'saving') return
    if (folders.length > 0 && confirm !== 'close') {
      setConfirm('close')
      return
    }
    void discard()
  }
  useEffect(() => {
    closeRef.current = close
  })

  const limitExcess = useLimitExcess(shop)
  // Двойной клик не запускает действие дважды.
  const flight = useSingleFlight()
  const run = async () => {
    if (!flight.enter()) return
    try {
      // Пачка проверяется целиком, как в обычной загрузке: не влезает в тариф —
      // не создаётся ни один альбом и не уходит ни одно фото.
      if (phase === 'pick') {
        const excess = limitExcess(photos, bytes)
        if (excess) {
          setOverLimit(excess)
          return
        }
      }
      setOverLimit('')
      const controller = new AbortController()
      abort.current = controller
      setPhase('uploading')
      setError('')
      onLock(true)

      let halted = false
      for (const start of live.current.filter((f) => f.files.length > 0 && !complete(f))) {
        let folder = start
        patch(folder.id, { error: undefined })
        if (!folder.albumId) {
          try {
            const title = folder.title.trim()
            const album = await api.createAlbum(shop.id, title)
            if (album.status !== 'draft') await api.setAlbumStatus(shop.id, album.id, 'draft')
            patch(folder.id, { albumId: album.id, savedTitle: title })
            folder = { ...folder, albumId: album.id }
          } catch (e) {
            patch(folder.id, { error: `Не удалось создать альбом: ${errorText(e)}` })
            // Предел числа альбомов один на все папки — дальше пробовать незачем.
            if (e instanceof ApiError && e.code === 'album_limit') {
              setError(errorText(e))
              halted = true
              break
            }
            continue
          }
        }

        const rest = folder.files.map((file, i) => ({ key: String(i), file })).filter((f) => !folder.sent.has(Number(f.key)))
        const part: Record<string, number> = {}
        const result = await uploadToAlbum({
          shopId: shop.id,
          albumId: folder.albumId as string,
          files: rest,
          signal: controller.signal,
          onProgress: (key, p) => {
            part[key] = p
            const sum = Object.values(part).reduce((a, b) => a + b, 0) + folder.sent.size * 100
            patch(folder.id, { percent: Math.round(sum / folder.files.length) })
          },
          onConfirmed: refresh,
        })
        const sent = new Set(folder.sent)
        for (const key of result.ok) sent.add(Number(key))
        patch(folder.id, {
          sent,
          percent: Math.round((sent.size / folder.files.length) * 100),
          error:
            result.failed.length > 0
              ? `${result.quota ? capitalize(result.quota) : 'Ошибка сети'}: загружено ${sent.size} из ${folder.files.length} фото`
              : undefined,
        })
        if (result.quota) setError(capitalize(result.quota))
        if (result.stopped || result.quota) {
          halted = true
          break
        }
      }

      onLock(false)
      const left = live.current.filter((f) => f.files.length > 0 && !complete(f))
      setPhase(!halted && left.length === 0 ? 'review' : 'paused')
    } finally {
      flight.leave()
    }
  }

  const publish = async () => {
    if (!flight.enter()) return
    try {
      setPhase('saving')
      setError('')
      onLock(true)
      const ready = live.current.filter((f) => f.albumId && complete(f))
      try {
        for (const f of ready) {
          const title = f.title.trim()
          if (title !== f.savedTitle) await api.updateAlbum(shop.id, f.albumId as string, { title })
          // Категории — при создании: их можно менять и во время загрузки (макет 10).
          for (const categoryId of f.categoryIds) await api.addAlbumToCategory(shop.id, categoryId, f.albumId as string)
          await api.setAlbumStatus(shop.id, f.albumId as string, 'published')
        }
      } catch (e) {
        onLock(false)
        setError(`Не все альбомы опубликованы: ${errorText(e)}`)
        setPhase('review')
        refresh()
        return
      }
      refresh()
      onClose(`${plural(ready.length, 'Создан', 'Созданы', 'Создано')} ${ready.length} ${albumsWord(ready.length)}`)
    } finally {
      flight.leave()
    }
  }

  const busy = phase === 'uploading' || phase === 'saving'

  const errCount = usable.filter((f) => f.error).length
  let footText: string
  if (error) footText = error
  else if (phase === 'paused' && errCount > 0)
    footText = `${doneFolders} из ${usable.length} ${plural(usable.length, 'папки', 'папок', 'папок')} ${plural(doneFolders, 'загружена', 'загружены', 'загружены')} · ${errCount === 1 ? 'в одной ошибка' : `ошибки в ${errCount}`}`
  else if (phase === 'uploading' || phase === 'paused')
    footText = `Загружено ${doneFolders} из ${usable.length} ${plural(usable.length, 'папки', 'папок', 'папок')} · ${sentPhotos} из ${photos} фото`
  else if (phase === 'review' || phase === 'saving') footText = 'Всё загружено · названия можно поправить'
  else if (usable.length === 0) footText = 'Альбомы создадутся со статусом «Опубликован»'
  else if (invalid) footText = 'Сократите название, чтобы продолжить'
  else footText = `${usable.length} ${albumsWord(usable.length)} · статус «Опубликован»`

  return (
    <>
      <div className="updlg__body">
        <div className="updlg__top">
          <WatermarkControl shop={shop} disabled={phase !== 'pick'} />
        </div>

        <input
          ref={dirInput}
          type="file"
          multiple
          className="hidden"
          // Атрибута нет в типах React: он нестандартный, но другого
          // способа выбрать папку целиком браузеры не дают.
          {...({ webkitdirectory: '' } as object)}
          onChange={(e) => {
            if (e.target.files) add(foldersFromInput(e.target.files))
            e.target.value = ''
          }}
        />

        {folders.length === 0 ? (
          <div
            className={`drop ${over ? 'drop--over' : ''}`}
            onDragOver={dragOver}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
          >
            {over ? (
              <>
                <span className="drop__ico" aria-hidden="true">
                  <Icon as={FolderPlus} size={26} />
                </span>
                <p className="drop__release">{release}</p>
              </>
            ) : canPickFolders ? (
              <>
                <span className="drop__ico" aria-hidden="true">
                  <Icon as={FolderPlus} size={26} />
                </span>
                <p>Перетащите папки сюда</p>
                <small>или выберите папку на компьютере</small>
                <button className="btn btn--ghost btn--sm" onClick={() => dirInput.current?.click()}>
                  <Icon as={Folder} size={18} />
                  Выбрать папки
                </button>
                <small>Каждая папка станет отдельным альбомом с её названием</small>
              </>
            ) : (
              <>
                <p>Этот браузер не умеет выбирать папки</p>
                <small>
                  Массовая загрузка работает на компьютере. С телефона добавляйте фото обычной загрузкой или со
                  страницы альбома.
                </small>
              </>
            )}
          </div>
        ) : (
          <div
            className="frows__wrap"
            onDragOver={dragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
            }}
            onDrop={drop}
          >
            {over && phase === 'pick' && <p className="upgrid__release">{release}</p>}
            <div className="updlg__listhead">
              <span>
                Папки · {folders.length} · {photos} фото · {formatMB(bytes)}
              </span>
              <span className="spacer" />
              {phase === 'pick' &&
                (
                  <>
                    <button className="btn btn--quiet btn--sm frows__act" onClick={() => dirInput.current?.click()}>
                      + Добавить папки
                    </button>
                    <button className="btn btn--quiet btn--sm frows__act" onClick={() => setConfirm('clear')}>
                      Очистить
                    </button>
                  </>
                )}
            </div>

            <ul className={`frows ${over ? 'frows--over' : ''}`}>
              {folders.map((f) => {
                const empty = f.files.length === 0
                const stage = phase !== 'pick'
                return (
                  <li key={f.id} className={`frow ${empty ? 'frow--empty' : ''}`}>
                    <span className="frow__ico" aria-hidden="true">
                      <Icon as={Folder} size={20} />
                    </span>
                    <div className="frow__main">
                      {empty ? (
                        <b className="frow__name">{f.title}</b>
                      ) : (
                        <FolderTitle
                          title={f.title}
                          disabled={phase === 'saving'}
                          onSave={(title) => patch(f.id, { title })}
                        />
                      )}
                      <small>
                        {f.files.length} фото{f.bytes > 0 && ` · ${formatMB(f.bytes)}`}
                      </small>
                      {!empty && f.title.trim() === '' && <small className="text-danger" role="alert">Укажите название</small>}
                      {empty && (
                        <small className="text-danger" role="alert">
                          Нет фото {FORMATS_HINT.split(' · ')[0]} — альбом не создастся
                        </small>
                      )}
                      {!empty && f.skipped > 0 && (
                        <small className="frow__warn">
                          {f.skipped} {plural(f.skipped, 'файл пропущен', 'файла пропущены', 'файлов пропущено')}: {f.skipReason}
                        </small>
                      )}
                      {f.nested > 0 && <small className="frow__warn">Вложенные папки пропущены: {f.nested}</small>}
                      {f.error && (
                        <small className="text-danger" role="alert">
                          {f.error}
                          {phase === 'paused' && (
                            <>
                              {' · '}
                              <button className="frow__retry" onClick={() => void run()}>
                                Повторить
                              </button>
                            </>
                          )}
                        </small>
                      )}
                    </div>
                    <div className="frow__cat">
                      {/* Категории можно менять и во время загрузки — они
                          применяются при создании альбомов. */}
                      <CategoryPicker
                        categories={categories}
                        value={f.categoryIds}
                        disabled={phase === 'saving' || empty}
                        onChange={(ids) => patch(f.id, { categoryIds: ids })}
                      />
                    </div>
                    <span className="frow__state">
                      {empty || f.error ? (
                        <Icon as={CircleAlert} size={20} className="frow__bad" aria-label="Ошибка" />
                      ) : stage && complete(f) ? (
                        <span className="frow__ok">
                          <Icon as={Check} size={16} />
                          Загружено
                        </span>
                      ) : phase === 'uploading' || phase === 'paused' ? (
                        <span className="frow__prog">
                          <b>{f.percent}%</b>
                          <i style={{ '--p': `${f.percent}%` } as CSSProperties} />
                        </span>
                      ) : null}
                    </span>
                    {!busy && (
                      <button
                        className="frow__x"
                        onClick={() => removeFolder(f)}
                        aria-label={`Убрать папку «${f.name}»`}
                      >
                        <Icon as={X} size={18} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <p className="hint">Внутри папок — фото {FORMATS_HINT.replace(' на одно фото', '')}. Вложенные папки не загружаются</p>
      </div>

      <div className="modal__foot">
        {overLimit && phase === 'pick' ? (
          <LimitError head="Альбомы не созданы" excess={overLimit} hint="Уберите лишние папки или" />
        ) : (
          <p
            aria-live="polite"
            className={`hint ${error || (invalid && phase === 'pick') || (phase === 'paused' && errCount > 0) ? 'text-danger' : ''}`}
          >
            {footText}
            {error && <LimitLink text={error} />}
          </p>
        )}
        <span className="spacer" />
        {phase === 'uploading' ? (
          <>
            <button className="btn btn--ghost" onClick={() => abort.current?.abort()}>
              Остановить
            </button>
            <button className="btn btn--primary" disabled>
              <Icon as={Upload} size={18} strokeWidth={2} />
              Загружаем…
            </button>
          </>
        ) : phase === 'paused' ? (
          <>
            <button className="btn btn--ghost" onClick={close}>
              Закрыть
            </button>
            <button className="btn btn--primary" onClick={() => void run()}>
              {errCount > 0 && <Icon as={Upload} size={18} strokeWidth={2} />}
              {errCount > 0 ? 'Повторить' : 'Продолжить'}
            </button>
          </>
        ) : phase === 'review' || phase === 'saving' ? (
          <>
            <button className="btn btn--ghost" onClick={close} disabled={busy}>
              Отмена
            </button>
            <button className="btn btn--primary" onClick={() => void publish()} disabled={busy || invalid}>
              <Icon as={Upload} size={18} strokeWidth={2} />
              {phase === 'saving' ? 'Создаём…' : `Создать ${usable.length} ${albumsWord(usable.length)}`}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--ghost" onClick={close}>
              Отмена
            </button>
            <button className="btn btn--primary" onClick={() => void run()} disabled={usable.length === 0 || invalid}>
              <Icon as={Upload} size={18} strokeWidth={2} />
              {usable.length > 0 ? `Загрузить ${usable.length} ${albumsWord(usable.length)}` : 'Загрузить'}
            </button>
          </>
        )}
      </div>
      {/* Макет 10 · «Массовая · Очистить» и «Закрыть — подтверждение». */}
      {confirm === 'clear' && (
        <ConfirmDialog
          title="Очистить список папок?"
          icon="trash"
          text={`Из загрузки уберутся все ${folders.length} ${plural(folders.length, 'папка', 'папки', 'папок')} — ${photos} фото. Файлы на компьютере останутся, папки можно выбрать заново.`}
          confirmLabel="Очистить"
          onCancel={() => setConfirm('no')}
          onConfirm={() => {
            setFolders([])
            setConfirm('no')
          }}
        />
      )}
      {confirm === 'close' && (
        <ConfirmDialog
          title="Закрыть без сохранения?"
          icon="warn"
          text="Альбомы не будут созданы. Выбранные папки, загруженные фото, названия и категории пропадут."
          cancelLabel="Вернуться"
          confirmLabel="Закрыть"
          onCancel={() => setConfirm('no')}
          onConfirm={() => void discard()}
        />
      )}
    </>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Название папки — будущего альбома (макет 10 · «Загружено — создать
// альбомы»): по карандашу — поле со счётчиком, синяя галочка сохраняет,
// крестик отменяет. Слишком длинное имя папки открывает поле сразу.
function FolderTitle({ title, disabled, onSave }: { title: string; disabled: boolean; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const tooLong = (v: string) => v.trim().length > MAX_TITLE
  const value = draft ?? title
  const bad = value.trim() === '' || tooLong(value)
  if (draft === null && !tooLong(title)) {
    return (
      <div className="frow__title">
        <b className="frow__name" title={title}>
          {title}
        </b>
        {!disabled && (
          <button className="frow__pen" onClick={() => setDraft(title)} aria-label={`Изменить название «${title}»`}>
            <Icon as={Pen} size={14} />
          </button>
        )}
      </div>
    )
  }
  const save = () => {
    if (bad) return
    onSave(value.trim())
    setDraft(null)
  }
  return (
    <>
      <div className="frow__edit">
        <span className={`frow__inp ${tooLong(value) ? 'frow__inp--bad' : ''}`}>
          <input
            value={value}
            autoFocus={draft !== null}
            disabled={disabled}
            aria-label="Название альбома"
            aria-invalid={bad}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(null)
              }
            }}
          />
          <small>
            {value.trim().length}/{MAX_TITLE}
          </small>
        </span>
        <button className="frow__save" onClick={save} disabled={bad || disabled} aria-label="Сохранить название">
          <Icon as={Check} size={16} />
        </button>
        <button className="frow__cancel" onClick={() => setDraft(null)} aria-label="Отменить">
          <Icon as={X} size={16} />
        </button>
      </div>
      {tooLong(value) && (
        <small className="text-danger" role="alert">
          Сократите название до {MAX_TITLE} символов
        </small>
      )}
    </>
  )
}
