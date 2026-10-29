import { X, Check, Plus, Trash2, ImagePlus, Upload, CircleAlert, GripVertical, WifiOff, Folders, LoaderCircle, RefreshCw, Image as ImageIcon } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { api, ApiError, errorText, type Album, type AlbumStatus, type Category } from '../api'
import { ACCEPT_ATTR, FORMATS_HINT, MAX_FILE_MB, plural, rejectReason, uploadToAlbum } from '../lib/uploadRun'
import { Icon } from '../lib/icons'
import { PLAN_NAMES } from '../lib/plans'
import { useShop } from './AppLayout'
import { shopWatermark, WatermarkControl } from './WatermarkControl'
import { PasswordControl, passwordError, type PasswordChoice } from './PasswordControl'
import { LimitError, LimitLink, useLimitExcess } from '../lib/limits'
import { useDialogClose } from '../lib/useDialogClose'
import { usePointerReorder } from '../lib/pointerReorder'
import { ConfirmDialog } from './ConfirmDialog'
import { CategoryPicker } from './CategoryPicker'
import { Thumb } from './Thumb'
import { useSingleFlight } from '../lib/singleFlight'
import { Portal } from '../lib/Portal'
import { useFlip } from '../lib/flip'
import { setLiftedDragImage } from '../lib/dragGhost'

// Создание альбома по макету 11 · Desktop · v2 — окном поверх сетки.
//
// Порядок шагов навязан пайплайном: фотографии можно грузить только в
// существующий альбом (presign просит album_id). Поэтому сначала создаём
// альбом, потом догружаем в него выбранные файлы, и только после этого
// закрываем окно — иначе продавец решит, что фото пропали.
const MAX_TITLE = 30
// Тот же предел у сервера (albums_handlers.go · maxAlbumDescription).
export const MAX_DESCRIPTION = 3500

const ACCESS: { id: AlbumStatus; label: string; hint: string }[] = [
  { id: 'published', label: 'Опубликован', hint: 'Альбом увидят все посетители витрины' },
  { id: 'unlisted', label: 'По ссылке', hint: 'Альбом откроется только по прямой ссылке' },
  { id: 'draft', label: 'Черновик', hint: 'Альбом не виден покупателям, даже по ссылке' },
]

type Item = { key: string; file: File; reject: string }

// Миниатюры рисуем только первым: сотня полноразмерных снимков в <img>
// съедает память телефона раньше, чем продавец нажмёт «Создать».
const PREVIEW_LIMIT = 48

export function NewAlbumDialog({
  shopId,
  categories,
  initialFiles = [],
  onClose,
}: {
  shopId: string
  categories: Category[]
  // Фото из окна «Загрузить фото», откуда продавец нажал «Создать альбом».
  initialFiles?: File[]
  onClose: (created?: Album) => void
}) {
  const queryClient = useQueryClient()
  const shop = useShop()
  const limitExcess = useLimitExcess(shop)
  const billing = useQuery({ queryKey: ['billing', shopId], queryFn: () => api.getBilling(shopId) })
  const fileInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [status, setStatus] = useState<AlbumStatus>('published')
  const [items, setItems] = useState<Item[]>(() =>
    initialFiles.map((file) => ({ key: crypto.randomUUID(), file, reject: rejectReason(file) })),
  )
  // «и ещё N» раскрывает следующую порцию миниатюр.
  const [previewLimit, setPreviewLimit] = useState(PREVIEW_LIMIT)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [menuRight, setMenuRight] = useState(false)
  useTileMenuDismiss(menuKey, setMenuKey)
  // «Изменить порядок» на тач-экране (макет 11 · Tablet/Mobile): ручки на
  // фото, меню по нажатию отключено, «Удалить все» скрыта.
  const [ordering, setOrdering] = useState(false)
  const tileReorder = usePointerReorder('tile-key')
  // Перестановка фото в окне — плавным переездом плиток (макет 11/12).
  const tilesRef = useRef<HTMLDivElement>(null)
  useFlip(tilesRef, 'tile-key')
  const [over, setOver] = useState(false)
  const [dragCount, setDragCount] = useState(0)
  // album — альбом уже создан: дальше только догрузка фото в него.
  const [album, setAlbum] = useState<Album | null>(null)
  const [busy, setBusy] = useState<'no' | 'album' | 'photos'>('no')
  const [error, setError] = useState('')
  // Превышение лимита тарифа («на 3 фото и 24 МБ») — своей строкой в футере,
  // пока продавец не поменял набор фото.
  const [limitHit, setLimitHit] = useState<{ excess: string; items: Item[] } | null>(null)
  const [titleError, setTitleError] = useState(false)
  const [password, setPassword] = useState<PasswordChoice>({ mode: 'none', value: '' })
  const shopWm = shopWatermark(shop)
  const [wm, setWm] = useState(shopWm)
  const [submitted, setSubmitted] = useState(false)
  const [percent, setPercent] = useState<Record<string, number>>({})
  const [done, setDone] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<'no' | 'clear' | 'close'>('no')
  const abort = useRef<AbortController | null>(null)
  // Плитка, которую сейчас перетаскивают внутри сетки.
  const [dragKey, setDragKey] = useState<string | null>(null)

  const valid = items.filter((i) => !i.reject)
  const rejected = items.length - valid.length
  const left = valid.filter((i) => !done.has(i.key))
  const failedCount = Object.keys(failed).length

  // Закрытие с набранной формой спрашивает подтверждение: выбранные файлы
  // и текст иначе пропадали молча, а заново тащить полсотни снимков обидно.
  // Набранный пароль и свой водяной знак — тоже введённые данные: в окне
  // правки альбома они спрашивают подтверждение, здесь закрывались молча.
  const dirty =
    items.length > 0 ||
    title.trim() !== '' ||
    description.trim() !== '' ||
    password.value !== '' ||
    wm.enabled !== shopWm.enabled ||
    wm.position !== shopWm.position
  const close = () => {
    if (busy !== 'no') return
    // Альбом уже есть — закрытие ничего не теряет, кроме недогруженных фото.
    if (album) {
      onClose(album)
      return
    }
    if (dirty && confirm !== 'close') {
      setConfirm('close')
      return
    }
    onClose()
  }

  const backdrop = useDialogClose(close)

  // Без фотографий публиковать нечего: покупатель попадёт в пустой альбом.
  const forcedDraft = valid.length === 0
  const effectiveStatus: AlbumStatus = forcedDraft ? 'draft' : status

  const addFiles = (list: FileList | null) => {
    if (!list) return
    // Список снимаем сразу, а не внутри функции обновления: FileList живой,
    // и input очищается сразу после вызова. React выполняет функцию позже —
    // к тому моменту список уже пуст, и выбранные файлы молча пропадали
    // при втором выборе или после любого другого действия в окне.
    const next = Array.from(list).map((file) => ({ key: crypto.randomUUID(), file, reject: rejectReason(file) }))
    setItems((prev) => [...prev, ...next])
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    // Плитку, брошенную мимо других плиток, браузер может выдать за файл.
    if (dragKey) {
      setDragKey(null)
      return
    }
    if (!album) addFiles(e.dataTransfer.files)
  }

  // Обложкой по умолчанию становится первое фото альбома, поэтому «сделать
  // обложкой» до загрузки — это просто поставить снимок первым.
  const makeCover = (key: string) =>
    setItems((prev) => {
      const item = prev.find((i) => i.key === key)
      return item ? [item, ...prev.filter((i) => i.key !== key)] : prev
    })

  // Порядок до загрузки — это просто порядок в списке: в нём файлы уйдут
  // на сервер, и в нём же встанут в альбоме (макет 11: «Перетащите фото,
  // чтобы поменять порядок»).
  const moveBefore = (targetKey: string, source = dragKey) => {
    if (!source || source === targetKey) return
    setItems((prev) => {
      const moving = prev.find((i) => i.key === source)
      if (!moving) return prev
      const rest = prev.filter((i) => i.key !== source)
      rest.splice(rest.findIndex((i) => i.key === targetKey), 0, moving)
      return rest
    })
    setDragKey(null)
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shopId] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
  }

  const upload = async (target: Album) => {
    if (left.length === 0) {
      onClose(target)
      return
    }
    const controller = new AbortController()
    abort.current = controller
    setBusy('photos')
    setFailed({})
    const result = await uploadToAlbum({
      shopId,
      albumId: target.id,
      files: left,
      signal: controller.signal,
      onProgress: (key, p) => setPercent((prev) => ({ ...prev, [key]: p })),
      onConfirmed: refresh,
    })
    const nowDone = new Set(done)
    for (const key of result.ok) nowDone.add(key)
    setDone(nowDone)
    setFailed(Object.fromEntries(result.failed.map((f) => [f.key, f.message])))
    setBusy('no')
    refresh()
    if (result.quota) {
      setError(`Альбом создан, но часть фото не поместилась: ${result.quota}.`)
      return
    }
    if (result.stopped || result.failed.length > 0) return
    onClose(target)
  }

  // Двойной клик не запускает действие дважды.
  const flight = useSingleFlight()
  const submit = async () => {
    if (!flight.enter()) return
    try {
      if (album) {
        await upload(album)
        return
      }
      const name = title.trim()
      setSubmitted(true)
      if (!name) {
        setTitleError(true)
        return
      }
      if (passwordError(password)) return
      // Лимит проверяем по нажатию «Создать альбом» и всей пачкой (макет 11):
      // не помещается — альбом не создаётся вовсе.
      const excess = limitExcess(valid.length, valid.reduce((sum, i) => sum + i.file.size, 0))
      setLimitHit(excess ? { excess, items } : null)
      if (excess) return
      setError('')
      setBusy('album')
      let created: Album
      try {
        const own = wm.enabled !== shopWm.enabled || wm.position !== shopWm.position
        // Черновиком: публикуем, только когда пароль и описание записаны.
        created = await api.createAlbum(shopId, name, undefined, own ? wm : undefined, 'draft')
      } catch (e) {
        setError(
          e instanceof ApiError && e.code === 'album_limit'
            ? 'Достигнут предел числа альбомов — удалите ненужные, чтобы создать новый.'
            : e instanceof ApiError
              ? `Не удалось создать альбом: ${errorText(e)}`
              : 'Не удалось создать альбом. Проверьте интернет и попробуйте ещё раз',
        )
        setBusy('no')
        return
      }
      setAlbum(created)

      // Остальные поля — отдельными запросами: создание принимает только
      // название. Их отказ не отменяет уже созданный альбом, поэтому
      // сообщаем и оставляем окно открытым.
      let settingsFailed = false
      try {
        // Пароль — раньше публикации: альбом не должен ни на секунду
        // оказаться открытым на витрине без него.
        if (description.trim() || password.mode === 'set') {
          await api.updateAlbum(shopId, created.id, {
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(password.mode === 'set' ? { password: password.value } : {}),
          })
        }
        if (effectiveStatus !== created.status) {
          await api.setAlbumStatus(shopId, created.id, effectiveStatus)
        }
        for (const id of categoryIds) await api.addAlbumToCategory(shopId, id, created.id)
      } catch {
        settingsFailed = true
        setError('Альбом создан, но часть настроек не сохранилась — поправьте их в альбоме.')
      }
      refresh()

      if (settingsFailed && left.length === 0) {
        setBusy('no')
        return
      }
      await upload(created)
    } finally {
      flight.leave()
    }
  }

  const limit = limitHit?.items === items ? limitHit.excess : ''
  const shown = items.slice(0, previewLimit)
  const coverKey = valid[0]?.key
  // Пока создаётся альбом, форма выглядит как была (макет 11 · «Создание»),
  // но не принимает ввод — см. inert ниже.
  const locked = busy === 'photos' || album !== null

  let primary: string
  if (busy === 'photos') primary = 'Загружаем фото…'
  else if (busy === 'album') primary = 'Создаём альбом…'
  else if (album) primary = failedCount > 0 ? `Повторить (${failedCount})` : left.length > 0 ? 'Продолжить загрузку' : 'Готово'
  else primary = 'Создать альбом'

  let footText: string
  if (busy === 'photos') footText = `Дождитесь загрузки фото: осталось ${Math.max(0, valid.length - done.size)}`
  else if (album && left.length > 0)
    footText = `Альбом создан · загружено ${done.size} из ${valid.length}${failedCount > 0 ? ` · ${failedCount} не ${plural(failedCount, 'загрузилось', 'загрузились', 'загрузились')}` : ''}`
  else if (items.length > 0)
    footText = `${valid.length} фото${rejected > 0 ? ` · ${rejected} не ${plural(rejected, 'загрузилось', 'загрузились', 'загрузились')}` : ''}`
  else footText = 'Обязательно только название'

  // Лимит фото исчерпан — вместо формы диалог лимита (макет 11): создавать
  // альбом, в который нельзя положить ни одного фото, незачем.
  const clearDialog =
    confirm === 'clear' ? (
      <ConfirmDialog
        title="Удалить все фото?"
          icon="trash"
        text={`Вы действительно хотите удалить загруженные фото? ${items.length === 1 ? 'Фото уберётся' : `Все ${items.length} фото уберутся`} из альбома — их придётся загрузить заново.`}
        confirmLabel="Удалить все"
        onCancel={() => setConfirm('no')}
        onConfirm={() => {
          setItems([])
          setConfirm('no')
        }}
      />
    ) : null

  if (!album && items.length === 0 && billing.data && billing.data.usage.photos >= shop.max_photos) {
    return (
      <Portal><div className="modal__back" role="alertdialog" aria-modal="true" aria-label="Достигнут лимит фото" {...backdrop}>
        <div className="modal modal--sm">
          <span className="confirm__ico" aria-hidden="true">
            <Icon as={Folders} size={22} />
          </span>
          <div className="modal__head">
            <h2>Достигнут лимит фото</h2>
          </div>
          <p className="modal__text">
            На вашем тарифе можно загрузить до {shop.max_photos.toLocaleString('ru-RU')} фото. Чтобы добавить
            новые, удалите ненужные фото или перейдите на тариф с большим лимитом.
          </p>
          {/* Шкала лимита (макет 11 · «Лимит альбомов» · quota). */}
          <div className="quota">
            <p>
              <span>Фото на тарифе «{PLAN_NAMES[shop.plan]}»</span>
              <b>
                {billing.data.usage.photos.toLocaleString('ru-RU')} из {shop.max_photos.toLocaleString('ru-RU')}
              </b>
            </p>
            <span className="quota__track">
              <span style={{ width: '100%' }} />
            </span>
          </div>
          <div className="modal__foot">
            <span className="spacer" />
            <button className="btn btn--ghost" onClick={() => onClose()}>
              Закрыть
            </button>
            <Link to="/billing" className="btn btn--primary">
              Сменить тариф
            </Link>
          </div>
        </div>
      </div></Portal>
    )
  }

  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label="Новый альбом" {...backdrop}>
      <div className="modal modal--sheet modal--album">
        <div className="modal__head">
          <div>
            <h2>Новый альбом</h2>
            <p>Добавьте фото и заполните данные — всё можно изменить позже в самом альбоме</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={close} aria-label="Закрыть" disabled={busy !== 'no'}>
            <Icon as={X} size={20} />
          </button>
        </div>

        <div className="modal__body" inert={busy === 'album'}>
          {/* Телефон (11 · Mobile): подзаголовок — первой строкой содержимого,
              а не в закреплённой шапке. */}
          <p className="modal__sub">Добавьте фото и заполните данные — всё можно изменить позже в самом альбоме</p>
          <div>
            <div className="field__row">
              <span className="whitespace-nowrap">
                Фото
                <span className="field__num">
                  {valid.length > 0 ? ` · ${valid.length}` : items.length === 0 ? ' · необязательно' : ''}
                </span>
              </span>
              <span className="spacer" />
              {items.length > 0 && <span className="field__cnt field__cnt--tip">Первое фото — обложка</span>}
              {items.length > 0 &&
                !locked &&
                (
                  <>
                    {items.length > 1 && (
                      <button className="btn btn--quiet btn--sm touch-only phbar__btn" aria-pressed={ordering} onClick={() => setOrdering((v) => !v)}>
                        <Icon as={ordering ? Check : GripVertical} />
                        {ordering ? 'Готово' : 'Изменить порядок'}
                      </button>
                    )}
                    {!ordering && (
                      <button className="btn btn--quiet btn--sm whitespace-nowrap phbar__btn" onClick={() => setConfirm('clear')}>
                        <Icon as={Trash2} />
                    Удалить все
                      </button>
                    )}
                  </>
                )}
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
              <PhotoDrop
                over={over}
                onOver={setOver}
                onDrop={drop}
                onPick={() => fileInput.current?.click()}
                release={
                  <>
                    <p>Отпустите, чтобы загрузить</p>
                    <small>Фото появятся здесь, можно сразу несколько</small>
                  </>
                }
              />
            ) : (
              <div className="upbox">
              <div
                ref={tilesRef}
                className={`upgrid upgrid--side ${over ? 'upgrid--over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  // Подсветка «бросьте файлы» — только для файлов, не для
                  // плиток, которые переставляют внутри сетки.
                  if (dragKey || album) return
                  setOver(true)
                  setDragCount(fileCount(e))
                }}
                onDragLeave={() => setOver(false)}
                onDrop={drop}
              >
                {!locked && !ordering && (
                  <button className="uptile" onClick={() => fileInput.current?.click()}>
                    <i>
                    <Icon as={Plus} size={20} />
                  </i>
                    <span>Добавить</span>
                  </button>
                )}
                {shown.map((item) => {
                  const problem = item.reject || failed[item.key]
                  const net = problem === 'Ошибка сети'
                  const isDone = done.has(item.key)
                  const menu = menuKey === item.key && !ordering && !locked
                  return (
                    <div
                      key={item.key}
                      className={`uptile2 ${net ? 'uptile2--net' : problem ? 'uptile2--bad' : ''} ${dragKey === item.key ? 'uptile2--drag is-dragging' : ''} ${menu ? 'is-menu' : ''} ${tileReorder.over === item.key ? 'uptile2--over' : ''}`}
                      data-tile-key={item.key}
                      onClick={(e) => {
                        // Тач-экран: нажатие на фото открывает меню вместо крестиков (макеты 10–12).
                        if ((e.target as HTMLElement).closest('button, [role="menu"]')) return
                        setMenuRight(tileOnRight(e.currentTarget))
                        setMenuKey((k) => (k === item.key ? null : item.key))
                      }}
                      draggable={!locked}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-katalog-tile', item.key)
                        e.dataTransfer.effectAllowed = 'move'
                        setLiftedDragImage(e)
                        // В следующем тике: перерисовка в dragstart обрывала перетаскивание.
                        setTimeout(() => setDragKey(item.key), 0)
                      }}
                      onDragEnd={() => setDragKey(null)}
                      onDragOver={(e) => {
                        if (dragKey) e.preventDefault()
                      }}
                      onDrop={(e) => {
                        if (!dragKey) return
                        e.preventDefault()
                        e.stopPropagation()
                        moveBefore(item.key)
                      }}
                    >
                      <Thumb file={item.file} />
                      {ordering && !locked && (
                        <span className="photo__handle" aria-label="Перетащить фото" {...tileReorder.handle(item.key, (from, to) => moveBefore(to, from))}>
                          <Icon as={GripVertical} size={14} />
                        </span>
                      )}
                      {problem ? (
                        <span className="uptile2__msg">
                          <Icon as={net ? WifiOff : CircleAlert} size={20} />
                          <b>{problem}</b>
                          {net ? (
                            busy === 'no' && (
                              <button className="uptile2__retry" onClick={() => void submit()}>
                                <Icon as={RefreshCw} size={13} />
                                Повторить
                              </button>
                            )
                          ) : (
                            <small title={item.file.name}>{item.file.name}</small>
                          )}
                        </span>
                      ) : busy === 'photos' && !isDone ? (
                        <span className="uptile2__up">
                          <b>{percent[item.key] ?? 0}%</b>
                          <i style={{ '--p': `${percent[item.key] ?? 0}%` } as CSSProperties} />
                        </span>
                      ) : isDone ? (
                        <span className="uptile2__ok" aria-label="Загружено">
                        <Icon as={Check} />
                      </span>
                      ) : item.key === coverKey ? (
                        <span className="uptile2__pct">Обложка</span>
                      ) : !locked ? (
                        <button
                          className="uptile2__cover"
                          onClick={() => {
                            makeCover(item.key)
                            setMenuKey(null)
                          }}
                        >
                          Сделать обложкой
                        </button>
                      ) : null}
                      {!locked && (
                        <button
                          className="uptile2__x"
                          onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                          aria-label={`Убрать ${item.file.name}`}
                          data-menu="Удалить"
                        >
                        <Icon as={X} size={20} />
                      </button>
                      )}
                      {menu && (
                        <TileMenu
                          right={menuRight}
                          onCover={item.key === coverKey || problem ? undefined : () => makeCover(item.key)}
                          onRemove={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                          onDone={() => setMenuKey(null)}
                        />
                      )}
                    </div>
                  )
                })}
                {items.length > shown.length && (
                  <button className="uptile2 uptile2--more" onClick={() => setPreviewLimit((n) => n + PREVIEW_LIMIT)}>
                  и ещё {items.length - shown.length}
                  <small>Показать</small>
                </button>
                )}
              </div>
              {over && <DropRelease count={dragCount} />}
              {items.length > 1 && !locked && (
                <p className="hint hint--i upbox__hint">Перетащите фото, чтобы поменять порядок</p>
              )}
              {!locked && <TouchHint ordering={ordering} />}
              </div>
            )}
            {rejected > 0 && !album ? (
              <p className="hint hint--err">Загрузите JPEG, PNG, WebP или HEIC до {MAX_FILE_MB} МБ</p>
            ) : (
              <p className="hint hint--i">Форматы {FORMATS_HINT}</p>
            )}
          </div>

          <div>
            <label className="field">
              <span className="field__row">
                <span>
                  Название <span className="req">*</span>
                </span>
                <span className="spacer" />
                <span className="field__cnt">
                  {title.length} / {MAX_TITLE}
                </span>
              </span>
              <input
                className="inp"
                value={title}
                maxLength={MAX_TITLE}
                disabled={locked}
                aria-invalid={titleError}
                aria-describedby={titleError ? 'new-title-err' : undefined}
                onChange={(e) => {
                  setTitle(e.target.value)
                  setTitleError(false)
                }}
                placeholder="Например, Stone Island · осень"
                autoFocus
              />
              {titleError && <span className="field__err" role="alert" id="new-title-err">Введите название альбома</span>}
            </label>

            <label className="field">
              <span className="field__row">
                <span>Описание</span>
                <span className="field__cnt">· необязательно</span>
                <span className="spacer" />
                <span className="field__cnt">
                  {description.length.toLocaleString('ru-RU')} / {MAX_DESCRIPTION.toLocaleString('ru-RU')}
                </span>
              </span>
              <textarea
                className="inp"
                rows={3}
                value={description}
                maxLength={MAX_DESCRIPTION}
                disabled={locked}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Размеры, материалы, условия заказа…"
              />
            </label>

            <div className="field field--cat">
              <span>Категории</span>
              <CategoryPicker sheet categories={categories} value={categoryIds} disabled={locked} onChange={setCategoryIds} />
            </div>

            <div className="field">
              <span>Доступ</span>
              <div className="segbar">
                {ACCESS.map((a) => (
                  <button
                    key={a.id}
                    aria-pressed={effectiveStatus === a.id}
                    disabled={locked || (forcedDraft && a.id !== 'draft')}
                    onClick={() => setStatus(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <p className="hint hint--i">
                {forcedDraft
                  ? 'Пока нет фото, альбом сохранится как черновик'
                  : ACCESS.find((x) => x.id === effectiveStatus)?.hint}
              </p>
            </div>

            {/* Планшет (макет 11 · Tablet): водяной знак — справа от пароля. */}
            <div className="albform__access">
            <PasswordControl
              plan={shop.plan}
              hasPassword={false}
              choice={password}
              onChange={(next) => {
                setPassword(next)
                setSubmitted(false)
              }}
              showError={submitted}
              disabled={locked}
            />

            {/* Знак альбома (макет 11–12 · «Водяной знак · Положение»). */}
            <WatermarkControl shop={shop} disabled={locked} value={wm} onChange={setWm} />
            </div>
          </div>
        </div>

        <div className="modal__foot">
          {/* Постоянная подсказка «Обязательно только название» на телефоне
              не показывается (11 · Mobile) — только состояние загрузки и ошибки. */}
          {limit ? (
            <LimitError head="Альбом не создан" excess={limit} hint="Удалите лишние фото или" />
          ) : (
            <p aria-live="polite" className={`hint ${error ? 'hint--err' : ''} ${!error && busy === 'no' && !album ? 'hint--idle' : ''}`}>
              {error && confirm !== 'close' ? error : footText}
              {error && confirm !== 'close' && <LimitLink text={error} />}
            </p>
          )}
          <span className="spacer" />
          {busy === 'photos' ? (
            <>
              <button className="btn btn--ghost" onClick={() => abort.current?.abort()}>
                Остановить
              </button>
              <button className="btn btn--primary" disabled>
                <Icon as={Upload} size={18} strokeWidth={2} />
                {primary}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn--ghost" onClick={close} disabled={busy !== 'no'}>
                {album ? 'Закрыть' : 'Отмена'}
              </button>
              <button className="btn btn--primary" onClick={() => void submit()} disabled={busy !== 'no'}>
                {busy === 'album' && <Icon as={LoaderCircle} className="spin" />}
                {primary}
              </button>
            </>
          )}
        </div>
      </div>
      {clearDialog}
      {/* Макет 11 · «Закрыть без сохранения». */}
      {confirm === 'close' && (
        <ConfirmDialog
          title="Закрыть без сохранения?"
          text={
            album
              ? 'Альбом уже создан. Фото, которые не успели загрузиться, в него не попадут.'
              : 'Альбом не будет создан. Введённые данные и добавленные фото пропадут.'
          }
          cancelLabel="Продолжить"
          confirmLabel="Закрыть"
          onCancel={() => setConfirm('no')}
          onConfirm={() => onClose()}
        />
      )}
    </div></Portal>
  )
}

// --- Общее для окон «Новый альбом» и «Редактировать альбом» (макеты 11–12) ---

// Число перетаскиваемых файлов — для «Отпустите, чтобы добавить N фото».
export function fileCount(e: DragEvent): number {
  return [...e.dataTransfer.items].filter((i) => i.kind === 'file').length
}

// Пустая зона фото: «Перетащите фото сюда / Выбрать файлы»; над ней тащат
// файлы — остаётся только иконка и release (макет 11 · «Перетаскивание фото»).
export function PhotoDrop({
  over,
  onOver,
  onDrop,
  onPick,
  release,
}: {
  over: boolean
  onOver: (on: boolean, e?: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onPick: () => void
  release: ReactNode
}) {
  return (
    <div
      className={`drop ${over ? 'drop--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        onOver(true, e)
      }}
      onDragLeave={() => onOver(false)}
      onDrop={onDrop}
    >
      <span className="drop__ico" aria-hidden="true">
        <Icon as={ImagePlus} size={26} />
      </span>
      {over ? (
        <div className="drop__release">{release}</div>
      ) : (
        <>
          {/* Телефон (макет 11 · Mobile): перетаскивать нечем — «Нажмите,
              чтобы выбрать фото», синяя кнопка «Выбрать фото». */}
          <p>
            <span className="hover-only">Перетащите фото сюда</span>
            <span className="touch-only-inline">Нажмите, чтобы выбрать фото</span>
          </p>
          <small>
            <span className="hover-only">или выберите файлы на компьютере</span>
            <span className="touch-only-inline">Из галереи, файлов или камеры</span>
          </small>
          <button className="btn btn--ghost btn--sm drop__pick" onClick={onPick}>
            <Icon as={Upload} strokeWidth={2} />
            <span className="hover-only">Выбрать файлы</span>
            <span className="touch-only-inline">Выбрать фото</span>
          </button>
          <small>Можно загрузить сразу несколько фото</small>
        </>
      )}
    </div>
  )
}

// Подсветка поверх сетки с фото, когда над ней тащат файлы (макет 11 ·
// «Перетаскивание пачки фото»): иконка, «Отпустите, чтобы добавить N фото».
export function DropRelease({ count }: { count: number }) {
  return (
    <div className="upbox__release" aria-hidden="true">
      <span>
        <Icon as={Upload} size={22} />
      </span>
      <b>Отпустите, чтобы добавить {count > 0 ? `${count} ` : ''}фото</b>
      <small>{FORMATS_HINT}</small>
    </div>
  )
}

// Подсказка под фото на тач-экране: в режиме порядка — про ручку.
export function TouchHint({ ordering }: { ordering: boolean }) {
  return (
    <p className="hint hint--i touch-hint">
      {ordering ? 'Перетащите фото за ручку, чтобы поменять порядок' : 'Чтобы удалить или изменить обложку, нажмите на фото'}
    </p>
  )
}

// Меню фото по нажатию на тач-экране (макет 11–12 · «Меню фото»): рядом с
// плиткой, у выбранной — синяя рамка; крестиков на плитках нет.
export function TileMenu({
  right,
  onCover,
  onRemove,
  onDone,
}: {
  right: boolean
  onCover?: () => void
  onRemove: () => void
  onDone: () => void
}) {
  return (
    <div className={`uptile2__menu ${right ? 'uptile2__menu--r' : ''}`} role="menu">
      {onCover && (
        <button
          role="menuitem"
          onClick={() => {
            onCover()
            onDone()
          }}
        >
          <Icon as={ImageIcon} size={16} />
          Сделать обложкой
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          onRemove()
          onDone()
        }}
      >
        <Icon as={Trash2} size={16} />
        Удалить
      </button>
    </div>
  )
}

// Меню раскрывается в сторону середины сетки, чтобы не уйти за край.
export function tileOnRight(tile: HTMLElement): boolean {
  const t = tile.getBoundingClientRect()
  const g = tile.parentElement?.getBoundingClientRect()
  return Boolean(g) && t.left + t.width / 2 > (g?.left ?? 0) + (g?.width ?? 0) / 2
}

// Меню фото закрывается нажатием мимо.
export function useTileMenuDismiss(menuKey: string | null, setMenuKey: (k: null) => void) {
  useEffect(() => {
    if (!menuKey) return
    const hide = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.uptile2.is-menu')) setMenuKey(null)
    }
    document.addEventListener('pointerdown', hide)
    return () => document.removeEventListener('pointerdown', hide)
  }, [menuKey, setMenuKey])
}
