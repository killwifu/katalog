import { X, Check, Plus, Trash2, CircleAlert, GripVertical, WifiOff } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { api, ApiError, errorText, type Album, type AlbumStatus, type Category } from '../api'
import { ACCEPT_ATTR, FORMATS_HINT, plural, rejectReason, uploadToAlbum } from '../lib/uploadRun'
import { LimitError, LimitLink, useLimitExcess } from '../lib/limits'
import { Icon } from '../lib/icons'
import { useShop } from './AppLayout'
import { shopWatermark, WatermarkControl } from './WatermarkControl'
import { PasswordControl, passwordError, type PasswordChoice } from './PasswordControl'
import { useDialogClose } from '../lib/useDialogClose'
import { usePointerReorder } from '../lib/pointerReorder'
import { ConfirmDialog } from './ConfirmDialog'
import { CategoryPicker } from './CategoryPicker'
import { Thumb } from './Thumb'
import { useSingleFlight } from '../lib/singleFlight'
import { Portal } from '../lib/Portal'
import { useFlip } from '../lib/flip'
import { setLiftedDragImage } from '../lib/dragGhost'
import {
  DropRelease,
  fileCount,
  MAX_DESCRIPTION,
  PhotoDrop,
  TileMenu,
  tileOnRight,
  TouchHint,
  useTileMenuDismiss,
} from './NewAlbumDialog'

// Редактирование альбома по макету 12 · Desktop · v2 — тем же окном, что и
// создание: слева фотографии, справа данные. Всё, что продавец меняет в
// окне, применяется одной кнопкой «Сохранить»: убранные фото уходят в
// «Удаленное», новые загружаются, обложка меняется. До сохранения альбом
// на витрине остаётся прежним.
const MAX_TITLE = 30

const ACCESS: { id: AlbumStatus; label: string; hint: string }[] = [
  { id: 'published', label: 'Опубликован', hint: 'Альбом увидят все посетители витрины' },
  { id: 'unlisted', label: 'По ссылке', hint: 'Альбом откроется только по прямой ссылке' },
  { id: 'draft', label: 'Черновик', hint: 'Альбом не виден покупателям, даже по ссылке' },
]

type NewItem = { key: string; file: File; reject: string }

export function EditAlbumDialog({
  shopId,
  album,
  categories,
  withPhotos = true,
  onClose,
}: {
  shopId: string
  album: Album
  categories: Category[]
  // Со страницы альбома форма открывается без фото — их меняют на самой
  // странице; карандаш в списке альбомов открывает полное окно (макет 13).
  withPhotos?: boolean
  // saved — изменения применены; страница покажет уведомление.
  onClose: (saved?: boolean) => void
}) {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(album.title)
  const [description, setDescription] = useState(album.description)
  // Альбом может лежать в нескольких категориях (макет 11–12 · «Выбор категорий»).
  const initialCats = album.category_ids ?? (album.category_id ? [album.category_id] : [])
  const [categoryIds, setCategoryIds] = useState<string[]>(initialCats)
  const catsChanged =
    categoryIds.length !== initialCats.length || categoryIds.some((id) => !initialCats.includes(id))
  const [status, setStatus] = useState<AlbumStatus>(album.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // «Удалить все» — с подтверждением (макет 12); фото уйдут в «Удаленное»
  // только после «Сохранить».
  const [clearing, setClearing] = useState(false)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [menuRight, setMenuRight] = useState(false)
  useTileMenuDismiss(menuKey, setMenuKey)
  // Телефон (макет 12 · Mobile): в форме первые 8 фото, «Показать все N
  // фото» раскрывает сетку на месте, «Свернуть» — обратно.
  const [phone] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [expanded, setExpanded] = useState(false)
  const shownLimit = phone && !expanded ? 8 : Infinity
  // «Изменить порядок» на тач-экране (макет 12 · Tablet): ручки на фото.
  const [ordering, setOrdering] = useState(false)
  const tileReorder = usePointerReorder('tile-key')
  // Перестановка фото в окне — плавным переездом плиток (макет 11/12).
  const tilesRef = useRef<HTMLDivElement>(null)
  useFlip(tilesRef, 'tile-key')
  const [confirmClose, setConfirmClose] = useState(false)
  const [over, setOver] = useState(false)
  const [dragCount, setDragCount] = useState(0)
  const dragOver = (on: boolean, e?: DragEvent) => {
    setOver(on)
    if (e) setDragCount(fileCount(e))
  }
  const shop = useShop()
  const limitExcess = useLimitExcess(shop)
  const [password, setPassword] = useState<PasswordChoice>({ mode: album.has_password ? 'keep' : 'none', value: '' })
  const initialWm = album.watermark ?? shopWatermark(shop)
  const [wm, setWm] = useState(initialWm)
  const wmChanged = wm.enabled !== initialWm.enabled || wm.position !== initialWm.position
  const [submitted, setSubmitted] = useState(false)
  const passwordChanged = password.mode === 'set' || (password.mode === 'none' && album.has_password)

  // Первая страница фотографий альбома: в окне ими управляют, а не листают.
  const photos = useQuery({
    queryKey: ['photos', shopId, album.id, 1],
    queryFn: () => api.listPhotos(shopId, album.id, 1),
    enabled: withPhotos,
  })
  const loaded = (photos.data?.photos ?? []).filter((p) => p.status === 'ready' && p.urls)
  // Порядок, набранный перетаскиванием; на сервер уходит по «Сохранить».
  const [order, setOrder] = useState<string[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const existing = order
    ? order.map((id) => loaded.find((p) => p.id === id)).filter((p): p is (typeof loaded)[number] => Boolean(p))
    : loaded
  const moveBefore = (targetId: string, source = dragId) => {
    if (!source || source === targetId) return
    const ids = existing.map((p) => p.id).filter((id) => id !== source)
    ids.splice(ids.indexOf(targetId), 0, source)
    setOrder(ids)
    setDragId(null)
  }
  const total = photos.data?.total ?? album.photo_count
  // Отложенные правки: применяются только по «Сохранить».
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [cover, setCover] = useState<string | null>(null)
  const [added, setAdded] = useState<NewItem[]>([])
  const [percent, setPercent] = useState<Record<string, number>>({})
  const validAdded = added.filter((i) => !i.reject)
  // Убранные фото из сетки исчезают (макет 12 · «Есть изменения»); вернуть
  // их — «Отмена» в окне.
  const visible = existing.filter((p) => !removed.has(p.id))
  // Превышение лимита — своей строкой в футере, пока не поменяли добавленные фото.
  const [limitHit, setLimitHit] = useState<{ excess: string; added: NewItem[] } | null>(null)
  const limit = limitHit?.added === added ? limitHit.excess : ''
  // Срок хранения «Удаленного» задаёт сервер (TRASH_KEEP_DAYS).
  const trash = useQuery({
    queryKey: ['trash', shopId, 1],
    queryFn: () => api.listTrash(shopId, 1),
    enabled: removed.size > 0 || clearing,
  })
  const keepDays = trash.data?.keep_days
  const restoreText = keepDays
    ? `их можно восстановить ${keepDays} ${plural(keepDays, 'день', 'дня', 'дней')}`
    : 'оттуда их можно восстановить'

  const currentCover = cover ?? album.cover_photo_id ?? existing[0]?.id ?? null
  const dirty =
    title !== album.title ||
    description !== album.description ||
    catsChanged ||
    status !== album.status ||
    removed.size > 0 ||
    cover !== null ||
    order !== null ||
    passwordChanged ||
    wmChanged ||
    added.length > 0
  const onlyAccess =
    (status !== album.status || passwordChanged) &&
    title === album.title &&
    description === album.description &&
    !catsChanged &&
    removed.size === 0 &&
    cover === null &&
    order === null &&
    !wmChanged &&
    added.length === 0
  // Публиковать пустой альбом незачем: покупатель попадёт на пустую страницу.
  const photosAfter = total - removed.size + validAdded.length
  // В отличие от создания, доступ пустого альбома не блокируется (макет 12 ·
  // «Пустой альбом») — только предупреждаем.
  const canPublish = photosAfter > 0
  const effectiveStatus: AlbumStatus = status

  const close = () => {
    if (busy) return
    if (dirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const backdrop = useDialogClose(close)

  const addFiles = (list: FileList | null) => {
    if (!list) return
    // Список снимаем сразу, а не внутри функции обновления: FileList живой,
    // и input очищается сразу после вызова. React выполняет функцию позже —
    // к тому моменту список уже пуст, и выбранные файлы молча пропадали
    // при втором выборе или после любого другого действия в окне.
    const next = Array.from(list).map((file) => ({ key: crypto.randomUUID(), file, reject: rejectReason(file) }))
    setAdded((prev) => [...prev, ...next])
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    // Плитку, брошенную мимо других плиток, браузер может выдать за файл.
    if (dragId) {
      setDragId(null)
      return
    }
    if (!busy) addFiles(e.dataTransfer.files)
  }
  const remove = (id: string) => setRemoved((prev) => new Set(prev).add(id))

  // Двойной клик не запускает действие дважды.
  const flight = useSingleFlight()
  const save = async () => {
    if (!flight.enter()) return
    try {
      const name = title.trim()
      if (!name) return
      setSubmitted(true)
      if (passwordError(password)) return
      // Лимит проверяем по «Сохранить» и всей пачкой (макет 12): не влезает —
      // не сохраняется ничего. Убранные фото места не освобождают: они уходят
      // в «Удаленное» и продолжают считаться в тарифе.
      const excess = limitExcess(validAdded.length, validAdded.reduce((sum, i) => sum + i.file.size, 0))
      setLimitHit(excess ? { excess, added } : null)
      if (excess) return
      setBusy(true)
      setError('')
      try {
        if (passwordChanged) {
          await api.updateAlbum(shopId, album.id, { password: password.mode === 'set' ? password.value : '' })
        }
        if (wmChanged) {
          await api.updateAlbum(shopId, album.id, { watermark: wm })
          // Фото перерисовываются в фоне, и адреса картинок меняются, когда
          // воркер закончит. Готового сигнала нет — перечитываем несколько раз.
          // ponytail: опрос по таймеру; если альбомы в тысячи фото — событие от воркера.
          for (const delay of [3000, 10000, 30000, 60000]) {
            setTimeout(() => {
              void queryClient.invalidateQueries({ queryKey: ['photos', shopId, album.id] })
              void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
            }, delay)
          }
        }
        // Новую обложку задаёт порядок (она уже стоит первой), а явно
        // выбранную раньше обложку снимаем — иначе она перекрыла бы порядок.
        const coverChanged = cover !== null && !removed.has(cover)
        if (name !== album.title || description !== album.description || (coverChanged && album.cover_photo_id)) {
          await api.updateAlbum(shopId, album.id, {
            title: name,
            description,
            ...(coverChanged && album.cover_photo_id ? { cover_photo_id: '' } : {}),
          })
        }
        for (const id of categoryIds.filter((c) => !initialCats.includes(c))) await api.addAlbumToCategory(shopId, id, album.id)
        for (const id of initialCats.filter((c) => !categoryIds.includes(c))) await api.removeAlbumFromCategory(shopId, id, album.id)
        if (order) {
          await api.setPhotoOrder(shopId, album.id, order.filter((id) => !removed.has(id)))
          setOrder(null)
        }
        for (const id of removed) await api.deletePhoto(id)
        setRemoved(new Set())

        if (validAdded.length > 0) {
          const result = await uploadToAlbum({
            shopId,
            albumId: album.id,
            files: validAdded,
            signal: new AbortController().signal,
            onProgress: (key, p) => setPercent((prev) => ({ ...prev, [key]: p })),
            onConfirmed: () => void queryClient.invalidateQueries({ queryKey: ['billing', shopId] }),
          })
          // Загруженное убираем из списка: повторное «Сохранить» догрузит
          // только то, что не доехало.
          setAdded((prev) => prev.filter((i) => !result.ok.includes(i.key)))
          if (result.failed.length > 0) {
            throw new Error(
              result.quota
                ? `Часть фото не поместилась: ${result.quota}`
                : `${result.failed.length} фото не ${plural(result.failed.length, 'загрузилось', 'загрузились', 'загрузились')} — нажмите «Сохранить» ещё раз`,
            )
          }
        }
        // Статус — последним: публиковать альбом, пока в него грузятся фото, рано.
        if (effectiveStatus !== album.status) await api.setAlbumStatus(shopId, album.id, effectiveStatus)
        onClose(true)
      } catch (e) {
        // Альбом удалили в другой вкладке или с телефона, пока окно было открыто.
        setError(
          e instanceof ApiError && e.status === 404
            ? 'Альбом уже удалён — например, в другой вкладке. Изменения не сохранить, закройте окно.'
            : errorText(e),
        )
      } finally {
        void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
        void queryClient.invalidateQueries({ queryKey: ['photos', shopId, album.id] })
        void queryClient.invalidateQueries({ queryKey: ['shops'] })
        setBusy(false)
      }
    } finally {
      flight.leave()
    }
  }

  const accessHint = ACCESS.find((a) => a.id === effectiveStatus)?.hint

  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label="Редактировать альбом" {...backdrop}>
      <div className={withPhotos ? 'modal modal--sheet modal--album' : 'modal modal--form modal--sheet modal--album'}>
        <div className="modal__head">
          <div>
            <h2>Редактировать альбом</h2>
            <p>
              {withPhotos ? 'Изменения применятся после нажатия «Сохранить»' : 'Фото меняются прямо на странице альбома'}
            </p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={close} aria-label="Закрыть" disabled={busy}>
            <Icon as={X} size={20} />
          </button>
        </div>

        <div className="modal__body" style={withPhotos ? undefined : { gridTemplateColumns: '1fr' }}>
          {/* Телефон (12 · Mobile): подзаголовок — первой строкой содержимого. */}
          <p className="modal__sub">
            {withPhotos ? 'Изменения применятся после нажатия «Сохранить»' : 'Фото меняются прямо на странице альбома'}
          </p>
          <div hidden={!withPhotos}>
            <div className="field__row">
              <span className="whitespace-nowrap">
                Фото<span className="field__num"> · {photosAfter}</span>
              </span>
              <span className="spacer" />
              {photosAfter > 0 && <span className="field__cnt field__cnt--tip">Первое фото — обложка</span>}
              {/* Макет 12 · «Удалить все фото»: сетка очищается, а в
                  «Удаленное» фото уходят только по «Сохранить». */}
              {visible.length + added.length > 0 &&
                !busy && (
                  <>
                    {visible.length > 1 && (
                      <button className="btn btn--quiet btn--sm touch-only phbar__btn" aria-pressed={ordering} onClick={() => setOrdering((v) => !v)}>
                        <Icon as={ordering ? Check : GripVertical} />
                        {ordering ? 'Готово' : 'Изменить порядок'}
                      </button>
                    )}
                    {!ordering && (
                      <button className="btn btn--quiet btn--sm whitespace-nowrap phbar__btn" onClick={() => setClearing(true)}>
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
            {/* Макет 12 · «Пустой альбом»: вместо сетки — зона загрузки. */}
            {photosAfter === 0 && added.length === 0 && !photos.isPending ? (
              <PhotoDrop
                over={over}
                onOver={dragOver}
                onDrop={drop}
                onPick={() => fileInput.current?.click()}
                release={
                  <>
                    <p>Отпустите, чтобы добавить {dragCount > 0 ? `${dragCount} ` : ''}фото</p>
                    <small>{FORMATS_HINT}</small>
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
                if (!dragId && !busy) dragOver(true, e)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={drop}
            >
              {!ordering && (
              <button className="uptile" onClick={() => fileInput.current?.click()} disabled={busy}>
                <i>
                    <Icon as={Plus} size={20} />
                  </i>
                <span>Добавить</span>
              </button>
              )}
              {added.map((item) => (
                <div
                  key={item.key}
                  className={`uptile2 ${item.reject ? 'uptile2--bad' : ''} ${menuKey === item.key && !busy ? 'is-menu' : ''}`}
                  onClick={(e) => {
                        // Тач-экран: нажатие на фото открывает меню вместо крестиков (макеты 10–12).
                        if ((e.target as HTMLElement).closest('button, [role="menu"]')) return
                        setMenuRight(tileOnRight(e.currentTarget))
                        setMenuKey((k) => (k === item.key ? null : item.key))
                      }}
                >
                  <Thumb file={item.file} />
                  {item.reject ? (
                    <span className="uptile2__msg">
                      <Icon as={item.reject === 'Ошибка сети' ? WifiOff : CircleAlert} size={20} />
                        <b>{item.reject}</b>
                      <small title={item.file.name}>{item.file.name}</small>
                    </span>
                  ) : (
                    busy ? (
                      <span className="uptile2__up">
                        <b>{percent[item.key] ?? 0}%</b>
                        <i style={{ '--p': `${percent[item.key] ?? 0}%` } as CSSProperties} />
                      </span>
                    ) : (
                      <span className="uptile2__pct">Новое</span>
                    )
                  )}
                  {!busy && (
                    <button
                      className="uptile2__x"
                      onClick={() => setAdded((prev) => prev.filter((i) => i.key !== item.key))}
                      aria-label={`Убрать ${item.file.name}`}
                      data-menu="Удалить"
                    >
                        <Icon as={X} size={20} />
                      </button>
                  )}
                  {menuKey === item.key && !busy && (
                    <TileMenu
                      right={menuRight}
                      onRemove={() => setAdded((prev) => prev.filter((i) => i.key !== item.key))}
                      onDone={() => setMenuKey(null)}
                    />
                  )}
                </div>
              ))}
              {visible.slice(0, Math.max(0, shownLimit - added.length)).map((p) => {
                const menu = menuKey === p.id && !ordering && !busy
                const makeCover = () => {
                  // Обложка — первое фото альбома (макет 13): фото
                  // переезжает в начало, как на странице альбома.
                  setCover(p.id)
                  setOrder([p.id, ...existing.map((x) => x.id).filter((id) => id !== p.id)])
                  setMenuKey(null)
                }
                return (
                  <div
                    key={p.id}
                    className={`uptile2 ${dragId === p.id ? 'uptile2--drag is-dragging' : ''} ${menu ? 'is-menu' : ''} ${tileReorder.over === p.id ? 'uptile2--over' : ''}`}
                    data-tile-key={p.id}
                    onClick={(e) => {
                        // Тач-экран: нажатие на фото открывает меню вместо крестиков (макеты 10–12).
                        if ((e.target as HTMLElement).closest('button, [role="menu"]')) return
                        setMenuRight(tileOnRight(e.currentTarget))
                        setMenuKey((k) => (k === p.id ? null : p.id))
                      }}
                    draggable={!busy}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-katalog-tile', p.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setLiftedDragImage(e)
                      // В следующем тике: перерисовка в dragstart обрывала перетаскивание.
                      setTimeout(() => setDragId(p.id), 0)
                    }}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => {
                      if (dragId) e.preventDefault()
                    }}
                    onDrop={(e) => {
                      if (!dragId) return
                      e.preventDefault()
                      e.stopPropagation()
                      moveBefore(p.id)
                    }}
                  >
                    <img src={p.urls!.small} alt={p.caption || ''} loading="lazy" />
                    {ordering && !busy && (
                      <span className="photo__handle" aria-label="Перетащить фото" {...tileReorder.handle(p.id, (from, to) => moveBefore(to, from))}>
                        <Icon as={GripVertical} size={14} />
                      </span>
                    )}
                    {p.id === currentCover ? (
                      <span className="uptile2__pct">Обложка</span>
                    ) : (
                      !busy && (
                        <button className="uptile2__cover" onClick={makeCover}>
                          Сделать обложкой
                        </button>
                      )
                    )}
                    {!busy && (
                      <button
                        className="uptile2__x"
                        onClick={() => {
                          remove(p.id)
                          setMenuKey(null)
                        }}
                        aria-label="Убрать фото из альбома"
                        data-menu="Удалить"
                        title="Убрать из альбома"
                      >
                        <Icon as={X} size={20} />
                      </button>
                    )}
                    {menu && (
                      <TileMenu
                        right={menuRight}
                        onCover={p.id === currentCover ? undefined : makeCover}
                        onRemove={() => remove(p.id)}
                        onDone={() => setMenuKey(null)}
                      />
                    )}
                  </div>
                )
              })}
              {photos.isPending && <div className="uptile2 uptile2--more">Загрузка…</div>}
              {total > existing.length && !photos.isPending && (
                <div className="uptile2 uptile2--more">ещё {total - existing.length} — на странице альбома</div>
              )}
            </div>
            {over && <DropRelease count={dragCount} />}
            {/* Телефон (12 · Mobile): «Показать все» и подсказка — внутри рамки фото. */}
            {phone && added.length + visible.length > 8 && (
              <button className="btn btn--ghost btn--sm w-full upbox__more" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Свернуть' : `Показать все ${added.length + visible.length} фото`}
              </button>
            )}
            {photosAfter > 1 && !busy && (
              <p className="hint hint--i upbox__hint">Перетащите фото, чтобы поменять порядок</p>
            )}
            {!busy && <TouchHint ordering={ordering} />}
            </div>
            )}
            <p className="hint hint--i">Форматы {FORMATS_HINT}</p>
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
                disabled={busy}
                aria-invalid={!title.trim()}
                aria-describedby={!title.trim() ? 'edit-title-err' : undefined}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
              {!title.trim() && <span className="field__err" role="alert" id="edit-title-err">Введите название альбома</span>}
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
                rows={4}
                value={description}
                maxLength={MAX_DESCRIPTION}
                disabled={busy}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Размеры, материалы, условия заказа…"
              />
            </label>

            <div className="field field--cat">
              <span>Категории</span>
              <CategoryPicker sheet categories={categories} value={categoryIds} disabled={busy} onChange={setCategoryIds} />
            </div>

            <div className="field">
              <span>Доступ</span>
              <div className="segbar">
                {ACCESS.map((a) => (
                  <button
                    key={a.id}
                    aria-pressed={effectiveStatus === a.id}
                    disabled={busy || album.blocked_by_moderator}
                    onClick={() => setStatus(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <p className="hint hint--i">
                {album.blocked_by_moderator
                  ? 'Альбом скрыт модератором — доступ сейчас не меняется'
                  : accessHint}
              </p>
              {!canPublish && effectiveStatus !== 'draft' && (
                <p className="hint hint--warn">В альбоме нет фото — покупатели увидят пустой альбом</p>
              )}
            </div>

            {/* Планшет (макет 12 · Tablet): водяной знак — справа от пароля. */}
            <div className="albform__access">
            <PasswordControl
              plan={shop.plan}
              hasPassword={album.has_password}
              choice={password}
              onChange={(next) => {
                setPassword(next)
                setSubmitted(false)
              }}
              showError={submitted}
              disabled={busy}
            />

            {/* Знак альбома (макет 11–12 · «Водяной знак · Положение»). */}
            <WatermarkControl shop={shop} disabled={busy} value={wm} onChange={setWm} />
            </div>
          </div>
        </div>

        <div className="modal__foot">
          {limit ? (
            <LimitError head="Изменения не сохранены" excess={limit} hint="Удалите лишние фото или" />
          ) : error ? (
            <p className="hint hint--err" role="alert">
              {error}
              <LimitLink text={error} />
            </p>
          ) : removed.size > 0 && !busy ? (
            // Макет 12 · «Есть изменения»: куда денутся убранные фото — в футере.
            <p className="hint hint--i">
              {removed.size} фото {plural(removed.size, 'переместится', 'переместятся', 'переместятся')} в «Удаленное» —{' '}
              {restoreText}
            </p>
          ) : (
            // Макет 12: «Изменений нет», пока ничего не тронуто; поменяли
            // только доступ или пароль — «Изменён доступ».
            !busy && <p className={`hint ${!dirty ? 'hint--idle' : ''}`}>{!dirty ? 'Изменений нет' : onlyAccess ? 'Изменён доступ' : ''}</p>
          )}
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={close} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={busy || !dirty || !title.trim()}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
      {confirmClose && (
        <ConfirmDialog
          title="Отменить изменения?"
          text="Изменения не сохранятся, альбом останется таким, каким был. Удалённые фото вернутся."
          cancelLabel="Продолжить"
          confirmLabel="Не сохранять"
          onCancel={() => setConfirmClose(false)}
          onConfirm={() => onClose()}
        />
      )}
      {clearing && (
        <ConfirmDialog
          title="Удалить все фото?"
          icon="trash"
          text={`Вы действительно хотите удалить все ${visible.length + added.length} фото альбома? После «Сохранить» они переместятся в «Удаленное» — ${restoreText}.`}
          confirmLabel="Удалить все"
          onCancel={() => setClearing(false)}
          onConfirm={() => {
            setRemoved(new Set(existing.map((p) => p.id)))
            setAdded([])
            setClearing(false)
            setOrdering(false)
          }}
        />
      )}
    </div></Portal>
  )
}
