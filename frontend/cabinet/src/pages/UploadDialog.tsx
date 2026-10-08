import { X, Check, ChevronDown, ChevronUp, Plus, Trash2, ImagePlus, Upload, CircleAlert, WifiOff } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react'
import { type Album, type Category, type Shop } from '../api'
import { Icon } from '../lib/icons'
import {
  ACCEPT_ATTR,
  FORMATS_HINT,
  formatMB,
  plural,
  rejectReason,
  uploadToAlbum,
} from '../lib/uploadRun'
import { useDialogClose } from '../lib/useDialogClose'
import { MassUpload } from './MassUpload'
import { ConfirmDialog } from './ConfirmDialog'
import { LimitLink, notUploaded, useLimitExcess } from '../lib/limits'
import { Thumb } from './Thumb'
import { WatermarkControl } from './WatermarkControl'
import { useSingleFlight } from '../lib/singleFlight'
import { fold } from '../lib/fold'
import { Portal } from '../lib/Portal'

// «Загрузить фото» с экрана альбомов по макету 10 · Desktop · v2.
//
// Две вкладки: обычная загрузка кладёт выбранные фото в уже существующие
// альбомы, массовая превращает папки с компьютера в новые альбомы.
// Водяной знак общий для обеих и живёт в настройках витрины: воркер
// читает его оттуда в момент обработки, отдельного «знака на загрузку»
// в пайплайне нет.
export function UploadDialog({
  shop,
  albums,
  categories,
  preselected,
  onCreateAlbum,
  onClose,
}: {
  shop: Shop
  albums: Album[]
  categories: Category[]
  preselected: string[]
  onCreateAlbum: () => void
  // done — текст для уведомления на экране альбомов; пусто, если окно
  // закрыли, ничего не загрузив.
  onClose: (done?: string) => void
}) {
  const [mode, setMode] = useState<'regular' | 'mass'>('regular')
  // Массовая загрузка — только на компьютере (макет 10): папки с телефона
  // и планшета не выбрать, а перетаскивания там нет.
  const [desktop] = useState(() => window.matchMedia('(min-width: 1024px) and (hover: hover)').matches)
  // Пока идёт работа, вкладку и крестик трогать нельзя: вторая вкладка
  // размонтировала бы первую вместе с её загрузкой.
  const [locked, setLocked] = useState(false)
  // Вкладка сама знает, есть ли что терять, и сама спрашивает
  // подтверждение — окно только передаёт ей нажатие на крестик.
  const closeRef = useRef<() => void>(() => onClose())
  const backdrop = useDialogClose(() => closeRef.current())

  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label="Загрузить фото" {...backdrop}>
      <div className="modal modal--sheet modal--upload">
        <div className="modal__head">
          <h2>Загрузить фото</h2>
          <span className="spacer" />
          <button className="modal__x" onClick={() => closeRef.current()} aria-label="Закрыть">
            <Icon as={X} size={20} />
          </button>
        </div>

        <div className="updlg__tabs">
          <div className="segbar">
            <button aria-pressed={mode === 'regular'} disabled={locked} onClick={() => setMode('regular')}>
              Обычная загрузка
            </button>
            <button
              aria-pressed={mode === 'mass'}
              disabled={locked || !desktop}
              onClick={() => setMode('mass')}
              title={desktop ? undefined : 'Массовая загрузка доступна только на компьютере'}
            >
              Массовая загрузка
              {!desktop && <small className="segbar__note">только на компьютере</small>}
            </button>
          </div>
        </div>

        {mode === 'regular' ? (
          <RegularUpload
            shop={shop}
            albums={albums}
            categories={categories}
            preselected={preselected}
            onCreateAlbum={onCreateAlbum}
            onClose={onClose}
            onLock={setLocked}
            closeRef={closeRef}
          />
        ) : (
          <MassUpload shop={shop} categories={categories} onClose={onClose} onLock={setLocked} closeRef={closeRef} />
        )}
      </div>
    </div></Portal>
  )
}

type Item = { key: string; file: File; reject: string }

// Миниатюры рисуем только первым: сотня полноразмерных снимков в <img>
// съедает память телефона раньше, чем продавец нажмёт «Загрузить».
const PREVIEW_LIMIT = 48
// Сколько альбомов показывать плашками в поле, остальные — «Ещё N».
const CHIPS_LIMIT = 4

function RegularUpload({
  shop,
  albums,
  categories,
  preselected,
  onCreateAlbum,
  onClose,
  onLock,
  closeRef,
}: {
  shop: Shop
  albums: Album[]
  categories: Category[]
  preselected: string[]
  onCreateAlbum: () => void
  onClose: (done?: string) => void
  onLock: (locked: boolean) => void
  closeRef: React.MutableRefObject<() => void>
}) {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<string[]>(preselected)
  const [items, setItems] = useState<Item[]>([])
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'uploading' | 'partial'>('pick')
  // Прогресс и итог считаются по парам «альбом + файл»: одно фото,
  // выбранное в два альбома, — это две загрузки.
  const [percent, setPercent] = useState<Record<string, number>>({})
  const [done, setDone] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [quota, setQuota] = useState('')
  const [overLimit, setOverLimit] = useState('')
  const limitExcess = useLimitExcess(shop)
  const [needAlbum, setNeedAlbum] = useState(false)
  const [confirm, setConfirm] = useState<'no' | 'clear' | 'close'>('no')
  const abort = useRef<AbortController | null>(null)

  const valid = items.filter((i) => !i.reject)
  const rejected = items.length - valid.length
  const bytes = valid.reduce((sum, i) => sum + i.file.size, 0)
  const pair = (albumId: string, key: string) => `${albumId}:${key}`

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return
    const next = Array.from(list).map((file) => ({ key: crypto.randomUUID(), file, reject: rejectReason(file) }))
    setItems((prev) => [...prev, ...next])
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (phase === 'pick') addFiles(e.dataTransfer.files)
  }

  const fullyDone = (key: string, set = done) => selected.every((a) => set.has(pair(a, key)))
  const doneCount = valid.filter((i) => fullyDone(i.key)).length
  const failedCount = valid.filter((i) => selected.some((a) => failed[pair(a, i.key)])).length

  const summary = (count = doneCount) =>
    count === 0
      ? undefined
      : `${count} фото ${plural(count, 'загружено', 'загружены', 'загружены')} в ${selected.length} ${plural(selected.length, 'альбом', 'альбома', 'альбомов')}`

  const close = () => {
    if (phase === 'uploading') return
    if (phase === 'partial') {
      onClose(summary())
      return
    }
    if (items.length > 0 && confirm !== 'close') {
      setConfirm('close')
      return
    }
    onClose()
  }
  useEffect(() => {
    closeRef.current = close
  })

  // Двойной клик не запускает действие дважды.
  const flight = useSingleFlight()
  const run = async () => {
    if (!flight.enter()) return
    try {
      if (selected.length === 0) {
        setNeedAlbum(true)
        return
      }
      if (valid.length === 0) return
      // Пачка проверяется целиком (макет 13): не влезает в тариф — не
      // загружается ни одно фото. Фото в несколько альбомов — это столько же
      // копий, каждая занимает место.
      if (phase === 'pick') {
        const excess = limitExcess(valid.length * selected.length, bytes * selected.length)
        if (excess) {
          setOverLimit(
            `${notUploaded(valid.length)}: ${excess}. Выберите меньше фото, удалите ненужные или смените тариф.`,
          )
          return
        }
      }
      setOverLimit('')
      const controller = new AbortController()
      abort.current = controller
      setPhase('uploading')
      onLock(true)
      setFailed({})
      setQuota('')

      const nowDone = new Set(done)
      const nowFailed: Record<string, string> = {}
      let stopped = false
      for (const albumId of selected) {
        const files = valid.filter((i) => !nowDone.has(pair(albumId, i.key)))
        if (files.length === 0) continue
        const result = await uploadToAlbum({
          shopId: shop.id,
          albumId,
          files,
          signal: controller.signal,
          onProgress: (key, p) => setPercent((prev) => ({ ...prev, [pair(albumId, key)]: p })),
          onConfirmed: () => {
            void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
            void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
            void queryClient.invalidateQueries({ queryKey: ['shops'] })
          },
        })
        for (const key of result.ok) nowDone.add(pair(albumId, key))
        for (const f of result.failed) {
          nowFailed[pair(albumId, f.key)] = f.message.charAt(0).toUpperCase() + f.message.slice(1)
        }
        setDone(new Set(nowDone))
        setFailed({ ...nowFailed })
        if (result.quota) {
          // Лимит тарифа: следующие альбомы упрутся в него же, а трафик
          // на загрузку уйдёт впустую.
          setQuota(result.quota)
          stopped = true
        }
        if (result.stopped || stopped) {
          stopped = true
          break
        }
      }

      onLock(false)
      const count = valid.filter((i) => fullyDone(i.key, nowDone)).length
      if (!stopped && count === valid.length) {
        onClose(summary(count))
        return
      }
      setPhase('partial')
    } finally {
      flight.leave()
    }
  }

  const itemPercent = (key: string) =>
    Math.round(selected.reduce((sum, a) => sum + (percent[pair(a, key)] ?? 0), 0) / Math.max(1, selected.length))
  const itemError = (key: string) => selected.map((a) => failed[pair(a, key)]).find(Boolean)

  const busy = phase === 'uploading'
  const shown = items.slice(0, PREVIEW_LIMIT)

  let footText: string
  if (overLimit && phase === 'pick') footText = overLimit
  else if (phase === 'uploading') footText = `Загружено ${doneCount} из ${valid.length}`
  else if (phase === 'partial')
    footText = quota
      ? `Загружено ${doneCount} из ${valid.length} — ${quota}`
      : `Загружено ${doneCount} из ${valid.length}${failedCount > 0 ? ` · ${failedCount} не ${plural(failedCount, 'загрузилось', 'загрузились', 'загрузились')}` : ''}`
  else if (needAlbum && selected.length === 0) footText = `${valid.length} фото`
  else if (items.length === 0 || selected.length === 0) footText = 'Выберите альбомы и добавьте фото'
  else if (rejected > 0)
    footText = `${rejected} ${plural(rejected, 'файл не подходит и не загрузится', 'файла не подходят и не загрузятся', 'файлов не подходят и не загрузятся')}`
  else
    footText = `${valid.length} фото → в ${selected.length} ${plural(selected.length, 'альбом', 'альбома', 'альбомов')}`

  return (
    <>
      <div className="updlg__body">
        <div className="updlg__top">
          <AlbumPicker
            albums={albums}
            categories={categories}
            selected={selected}
            disabled={phase !== 'pick'}
            invalid={needAlbum && selected.length === 0}
            onChange={(next) => {
              setSelected(next)
              setNeedAlbum(false)
            }}
            onCreateAlbum={onCreateAlbum}
          />
          <WatermarkControl shop={shop} disabled={phase !== 'pick'} />
        </div>

        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {items.length === 0 ? (
          <div
            className={`drop ${over ? 'drop--over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
          >
            <span className="drop__ico" aria-hidden="true">
              <Icon as={ImagePlus} size={26} />
            </span>
            {/* Телефон: перетаскивать нечем (макет 11 · Mobile). */}
            <p>
              <span className="hover-only">{over ? 'Отпустите, чтобы добавить фото' : 'Перетащите фото сюда'}</span>
              <span className="touch-only-inline">Нажмите, чтобы выбрать фото</span>
            </p>
            <small>
              <span className="hover-only">или выберите файлы на компьютере</span>
              <span className="touch-only-inline">Из галереи, файлов или камеры</span>
            </small>
            <button className="btn btn--ghost btn--sm drop__pick" onClick={() => fileInput.current?.click()}>
              <Icon as={Upload} size={18} strokeWidth={2} />
              <span className="hover-only">Выбрать файлы</span>
              <span className="touch-only-inline">Выбрать фото</span>
            </button>
            <small>Можно загрузить сразу несколько фото</small>
          </div>
        ) : (
          <div>
            <div className="updlg__listhead">
              <span>
                Фото · {valid.length}
                {bytes > 0 && ` · ${formatMB(bytes)}`}
              </span>
              <span className="spacer" />
              {phase === 'pick' &&
                (
                  <button className="btn btn--quiet btn--sm whitespace-nowrap phbar__btn" onClick={() => setConfirm('clear')}>
                    <Icon as={Trash2} />
                    Удалить все
                  </button>
                )}
            </div>
            <div
              className={`upgrid ${over ? 'upgrid--over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={drop}
            >
              {phase === 'pick' && (
                <button className="uptile" onClick={() => fileInput.current?.click()}>
                  <i>
                    <Icon as={Plus} size={20} />
                  </i>
                  <span>Добавить</span>
                </button>
              )}
              {shown.map((item) => {
                const error = item.reject || itemError(item.key)
                const isDone = !item.reject && selected.length > 0 && fullyDone(item.key)
                return (
                  <div
                    key={item.key}
                    className={`uptile2 ${error ? 'uptile2--bad' : ''} ${menuKey === item.key ? 'is-menu' : ''}`}
                    onClick={(e) => {
                        // Тач-экран: нажатие на фото открывает меню вместо крестиков (макеты 10–12).
                        if (!(e.target as HTMLElement).closest('button')) setMenuKey((k) => (k === item.key ? null : item.key))
                      }}
                  >
                    <Thumb file={item.file} />
                    {error ? (
                      <span className="uptile2__msg">
                        <Icon as={error === 'Ошибка сети' ? WifiOff : CircleAlert} size={20} />
                        <b>{error}</b>
                        <small title={item.file.name}>{item.file.name}</small>
                      </span>
                    ) : busy && !isDone ? (
                      <span className="uptile2__pct">{itemPercent(item.key)}%</span>
                    ) : isDone ? (
                      <span className="uptile2__ok" aria-label="Загружено">
                        <Icon as={Check} />
                      </span>
                    ) : null}
                    {phase === 'pick' && (
                      <button
                        className="uptile2__x"
                        onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                        aria-label={`Убрать ${item.file.name}`}
                        data-menu="Убрать из загрузки"
                      >
                        <Icon as={X} size={20} />
                      </button>
                    )}
                  </div>
                )
              })}
              {items.length > shown.length && (
                <div className="uptile2 uptile2--more">и ещё {items.length - shown.length}</div>
              )}
            </div>
          </div>
        )}
        {items.length > 0 && phase === 'pick' && (
          <p className="hint hint--i touch-hint">Чтобы убрать фото из загрузки, нажмите на него</p>
        )}
        <p className="hint hint--i">Форматы {FORMATS_HINT}</p>
      </div>

      <div className="modal__foot">
        <p
          aria-live="polite"
          className={`hint ${quota || overLimit || failedCount > 0 || (rejected > 0 && phase === 'pick') ? 'hint--err' : ''}`}
        >
          {footText}
          <LimitLink text={footText} />
        </p>
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
        ) : phase === 'partial' ? (
          <>
            <button className="btn btn--ghost" onClick={close}>
              Закрыть
            </button>
            {quota ? (
              // Упёрлись в тариф: повтор упадёт так же, нужен другой тариф
              // или свободное место.
              <Link to="/billing" className="btn btn--primary">
                Сменить тариф
              </Link>
            ) : (
              <button className="btn btn--primary" onClick={() => void run()}>
                {failedCount > 0 && <Icon as={Upload} size={18} strokeWidth={2} />}
                {failedCount > 0 ? `Повторить (${failedCount})` : 'Продолжить'}
              </button>
            )}
          </>
        ) : (
          <>
            <button className="btn btn--ghost" onClick={close}>
              Отмена
            </button>
            <button
              className="btn btn--primary"
              onClick={() => void run()}
              disabled={valid.length === 0 || (selected.length === 0 && needAlbum)}
            >
              <Icon as={Upload} size={18} strokeWidth={2} />
              {valid.length > 0 ? `Загрузить ${valid.length} фото` : 'Загрузить'}
            </button>
          </>
        )}
      </div>
      {/* Макет 10 · «Удалить все фото — подтверждение». */}
      {confirm === 'clear' && (
        <ConfirmDialog
          title="Удалить все фото?"
          icon="trash"
          text={`Вы действительно хотите удалить загруженные фото? ${items.length === 1 ? 'Фото уберётся' : `Все ${items.length} фото уберутся`} из загрузки. Файлы на компьютере останутся.`}
          confirmLabel="Удалить все"
          onCancel={() => setConfirm('no')}
          onConfirm={() => {
            setItems([])
            setConfirm('no')
          }}
        />
      )}
      {confirm === 'close' && (
        <ConfirmDialog
          title="Закрыть без загрузки?"
          text="Выбранные фото не загрузятся. Файлы на компьютере останутся."
          cancelLabel="Вернуться"
          confirmLabel="Закрыть"
          onCancel={() => setConfirm('no')}
          onConfirm={() => onClose()}
        />
      )}
    </>
  )
}

function AlbumPicker({
  albums,
  categories,
  selected,
  disabled,
  invalid,
  onChange,
  onCreateAlbum,
}: {
  albums: Album[]
  categories: Category[]
  selected: string[]
  disabled: boolean
  invalid: boolean
  onChange: (ids: string[]) => void
  onCreateAlbum: () => void
}) {
  const labelId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    // Esc закрывает только список альбомов, а не всё окно загрузки: ловим
    // на погружении и помечаем обработанным (см. useDialogClose).
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.title])), [categories])
  const byId = useMemo(() => new Map(albums.map((a) => [a.id, a])), [albums])
  const norm = fold(query.trim())
  const list = albums.filter((a) => !norm || fold(a.title).includes(norm))
  const chips = selected.map((id) => byId.get(id)).filter((a): a is Album => Boolean(a))

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  return (
    <div className="apick" ref={box}>
      <span className="wm__label" id={labelId}>
        В какие альбомы загрузить{selected.length > CHIPS_LIMIT && ` · ${selected.length}`}
      </span>
      <div
        className={`apick__field ${open ? 'apick__field--open' : ''} ${invalid ? 'apick__field--bad' : ''}`}
        role="combobox"
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
          }
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        {chips.length === 0 && <span className="apick__ph">Выберите один или несколько альбомов</span>}
        {chips.slice(0, CHIPS_LIMIT).map((a) => (
          <span key={a.id} className="apick__chip">
            <span>{a.title}</span>
            {!disabled && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(a.id)
                }}
                aria-label={`Убрать «${a.title}»`}
              >
                        <Icon as={X} size={14} />
                      </button>
            )}
          </span>
        ))}
        {chips.length > CHIPS_LIMIT && <span className="apick__chip">Ещё {chips.length - CHIPS_LIMIT}</span>}
        <span className="spacer" />
        <Icon as={open ? ChevronUp : ChevronDown} size={18} strokeWidth={2} />
      </div>
      {invalid && <p className="wm__err">Выберите хотя бы один альбом</p>}

      {open && (
        <div className="apick__menu">
          <input
            className="inp"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию альбома"
            aria-label="Поиск по названию альбома"
            autoFocus
          />
          <button className="apick__new" onClick={onCreateAlbum}>
            <Icon as={Plus} />
            Создать альбом
          </button>
          <div className="apick__list" role="listbox" aria-multiselectable="true">
            {list.map((a) => (
              <label key={a.id} className="apick__row" role="option" aria-selected={selected.includes(a.id)}>
                <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
                {a.cover_urls ? <img src={a.cover_urls.small} alt="" loading="lazy" /> : <i aria-hidden="true" />}
                <span>
                  <b>{a.title}</b>
                  <small>
                    {(a.category_id && catName.get(a.category_id)) || 'Без категории'} · {a.photo_count} фото
                  </small>
                </span>
              </label>
            ))}
            {list.length === 0 && (
              <p className="apick__none">{albums.length === 0 ? 'Альбомов пока нет' : 'Ничего не найдено'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
