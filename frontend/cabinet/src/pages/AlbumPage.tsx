import { Check, Download, EyeOff, Info, GripVertical, Trash2, Folder, ChevronLeft, Ellipsis, Lock, Pen, Share2, Upload, X, Plus, CircleAlert, ImagePlus, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import { api, errorText, type Photo } from '../api'
import { Icon } from '../lib/icons'
import { setFlash } from '../lib/flash'
import { plural } from '../lib/uploadRun'
import { LimitError, notUploaded, useLimitExcess } from '../lib/limits'
import { ACCEPT_ATTR, FORMATS_HINT, rejectReason, uploadToAlbum } from '../lib/uploadRun'
import { usePointerReorder } from '../lib/pointerReorder'
import { TileMenu, tileOnRight, useTileMenuDismiss } from './NewAlbumDialog'
import { Thumb } from './Thumb'
import { useShop } from './AppLayout'
import { Toast } from './Toast'
import { AccessDialog } from './AccessDialog'
import { EditAlbumDialog } from './EditAlbumDialog'
import { Popover } from './Popover'
import { SelectAll } from './SelectAll'
import { shopWatermark } from './WatermarkControl'
import { PaidLock } from '../lib/plans'
import { ShareDialog } from './ShareDialog'
import { Portal } from '../lib/Portal'
import { useFlip } from '../lib/flip'
import { setLiftedDragImage } from '../lib/dragGhost'

// Страница альбома по макету 13 · Desktop · v2. Шапка отвечает «что это за
// альбом и что с ним делать», ниже сразу фотографии: правка названия и
// описания уехала в окно (макет 12), чтобы форма не отжимала сетку вниз.
export function AlbumPage() {
  const shop = useShop()
  const { albumId } = useParams({ from: '/app/albums/$albumId' })
  const queryClient = useQueryClient()

  // Фото подгружаются по мере прокрутки (макет 13), страниц с кнопками
  // нет: альбом — одна лента, которую продавец листает и переставляет.
  const photos = useInfiniteQuery({
    queryKey: ['photos', shop.id, albumId, 'feed'],
    queryFn: ({ pageParam }) => api.listPhotos(shop.id, albumId, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.per_page < last.total ? last.page + 1 : undefined),
    // Пока есть необработанные фото — опрашиваем статусы.
    refetchInterval: (query) =>
      query.state.data?.pages.some((pg) =>
        pg.photos.some((p) => p.status === 'processing' || p.status === 'uploading'),
      )
        ? 2000
        : false,
  })
  const total = photos.data?.pages[photos.data.pages.length - 1]?.total
  // Не обработанные воркером фото: в сетке они есть, а в счётчике альбома
  // (photo_count — только готовые) нет. Над сеткой было «29 фото», в шапке —
  // «28 фото»; считаем так же, как шапка, а ошибки называем отдельно.
  const failedCount = photos.data?.pages.reduce((n, pg) => n + pg.photos.filter((p) => p.status === 'failed').length, 0) ?? 0
  // Счётчик фото, обложка и «обновлён» в шапке — из списка альбомов, а он
  // не перезапрашивался, пока воркер обрабатывал загруженное: в сетке три
  // фото, в шапке «0 фото». Обработка закончилась — обновляем список.
  const processing = Boolean(
    photos.data?.pages.some((pg) => pg.photos.some((p) => p.status === 'processing' || p.status === 'uploading')),
  )
  const wasProcessing = useRef(false)
  useEffect(() => {
    if (wasProcessing.current && !processing) {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    }
    wasProcessing.current = processing
  }, [processing, queryClient, shop.id])
  // Сторож в конце сетки: показался — грузим следующую порцию.
  const sentinel = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = photos
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasNextPage) return
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
      },
      { rootMargin: '600px' },
    )
    watcher.observe(node)
    return () => watcher.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // Счётчики квоты живут в двух запросах: мегабайты приходят из shops,
  // а число фотографий — из billing. Обновлять надо оба, иначе продавец
  // у лимита видит вчерашнее число и не понимает, почему загрузка встала.
  const refreshQuota = () => {
    void queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
    // Счётчик и обложка в шапке — из списка альбомов: после удаления или
    // возврата фото там оставалось прежнее число.
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
  }

  // Загрузка прямо в сетку (макет 13): плитки с процентами встают сразу
  // после обложки, загруженные становятся обычными фото, статус — над
  // сеткой. Пачка проверяется по лимиту целиком.
  // reject — файл не прошёл проверку формата/размера: красная плитка с
  // именем файла, убирается крестиком (макет 13 · «Ошибки загрузки фото»).
  type Pending = { key: string; file: File; pct: number; error?: string; reject?: boolean }
  const [pending, setPending] = useState<Pending[]>([])
  // Пачка не влезла в тариф (макет 13 · «Лимит фото / объёма»): красная
  // строка над сеткой вместо подсказки.
  const [limit, setLimit] = useState<{ head: string; excess: string; hint: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // Перестановка фото — плавным переездом плиток (макет 13 · Изменить порядок).
  const gallery = useRef<HTMLDivElement>(null)
  useFlip(gallery, 'photo-id')
  const limitExcess = useLimitExcess(shop)
  // Не доехавшее по сети — заново той же дорогой, без повторной проверки
  // форматов (плитка уже прошла её при выборе).
  const retryPending = (key: string) => {
    const item = pending.find((p) => p.key === key)
    if (!item) return
    setPending((prev) => prev.filter((p) => p.key !== key))
    void startUpload([item.file])
  }
  const startUpload = async (list: File[]) => {
    const files = list.filter((f) => !rejectReason(f))
    const excess = limitExcess(files.length, files.reduce((sum, f) => sum + f.size, 0))
    if (excess) {
      setLimit({ head: notUploaded(files.length), excess, hint: 'Выберите меньше фото, удалите ненужные или' })
      return
    }
    setLimit(null)
    const rejected = list
      .filter((f) => rejectReason(f))
      .map((file) => ({ key: crypto.randomUUID(), file, pct: 0, error: rejectReason(file), reject: true }))
    const batch = files.map((file) => ({ key: crypto.randomUUID(), file, pct: 0 }))
    setPending((prev) => [...batch, ...rejected, ...prev])
    if (batch.length === 0) return
    const result = await uploadToAlbum({
      shopId: shop.id,
      albumId,
      files: batch,
      signal: new AbortController().signal,
      onProgress: (key, pct) => setPending((prev) => prev.map((p) => (p.key === key ? { ...p, pct } : p))),
      onConfirmed: refreshQuota,
    })
    // Доехавшие уже пришли в ленту обычными фото — плитки убираем; не
    // доехавшие остаются с причиной, их можно убрать крестиком.
    const reasons = new Map(result.failed.map((f) => [f.key, f.message]))
    await queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
    setPending((prev) =>
      prev
        .filter((p) => !result.ok.includes(p.key))
        .map((p) => (reasons.has(p.key) ? { ...p, error: reasons.get(p.key) } : p)),
    )
    if (result.quota) setLimit({ head: notUploaded(result.failed.length), excess: result.quota, hint: 'Удалите ненужные или' })
    refreshQuota()
  }
  const uploading = pending.some((p) => !p.error)
  // Режим «Изменить порядок» (макет 13 · Tablet/Mobile): на тач-экране
  // перетаскивания HTML5 нет, поэтому фото тянут за ручку указателем.
  // Чекбоксы, плитка загрузки и действия на фото в режиме скрыты; каждое
  // перемещение сохраняется сразу.
  const [ordering, setOrdering] = useState(false)
  // Тач-экран (макет 13 · «Меню фото»): нажатие на фото открывает меню
  // «Сделать обложкой» / «Удалить»; выбор — чекбоксом.
  // Меню открывается под плиткой, в сторону середины сетки.
  const [menu, setMenu] = useState<{ id: string; right: boolean } | null>(null)
  useTileMenuDismiss(menu?.id ?? null, () => setMenu(null))
  // Телефон (макет 13 · Mobile · «Изменить порядок»): фото «поднимается»
  // долгим нажатием на ручку; на планшете — сразу.
  const [phone] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const photoReorder = usePointerReorder('photo-id', phone ? 350 : 0)
  const upDone = pending.filter((p) => p.pct >= 100).length
  const failedTiles = pending.filter((p) => p.error).length

  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const album = albums.data?.find((a) => a.id === albumId)
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })
  // На Бесплатном статистика альбома закрыта (сервер ответит 403).
  const stats = useQuery({
    queryKey: ['album-stats', shop.id, albumId],
    queryFn: () => api.getAlbumStats(shop.id, albumId),
    enabled: shop.plan !== 'free',
  })

  // 'wm' — открыто из «Водяной знак · Настроить»: в окне есть блок знака.
  const [editing, setEditing] = useState<false | 'form' | 'wm'>(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sharing, setSharing] = useState(false)

  // spin — идёт работа (крутилка, тост не гаснет сам); sticky — ошибка,
  // которая висит, пока её не закроют (макет 13 · «Архив не собрался»).
  const [toast, setToast] = useState<{
    text: string
    undo?: () => void
    retry?: () => void
    spin?: boolean
    sticky?: boolean
  } | null>(null)
  useEffect(() => {
    if (!toast || toast.spin || toast.sticky) return
    const timer = setTimeout(() => setToast(null), toast.undo ? 10000 : 5000)
    return () => clearTimeout(timer)
  }, [toast])

  // Удалённое уходит в корзину, поэтому подтверждения нет — есть «Отменить».
  // Раньше крестик требовал второго тапа: тогда фото пропадало насовсем.
  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deletePhoto(id)))
      return ids.filter((_, i) => results[i].status === 'fulfilled')
    },
    onSuccess: (gone, ids) => {
      setPicked(new Set())
      refreshQuota()
      if (gone.length === 0) {
        setToast({ text: 'Не удалось удалить фото. Проверьте интернет' })
        return
      }
      setToast({
        text:
          `${gone.length} фото ${plural(gone.length, 'перемещено', 'перемещены', 'перемещены')} в «Удаленное»` +
          (gone.length < ids.length ? ` · ${ids.length - gone.length} не удалось удалить` : ''),
        undo: () => {
          void Promise.allSettled(gone.map((id) => api.restorePhoto(shop.id, id))).then((back) => {
            refreshQuota()
            const ok = back.filter((r) => r.status === 'fulfilled').length
            setToast({
              text: ok === gone.length ? 'Фото возвращены в альбом' : `Вернулось ${ok} из ${gone.length} — остальные в «Удаленном»`,
            })
          })
        },
      })
    },
  })

  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [access, setAccess] = useState(false)
  const [deletingAlbum, setDeletingAlbum] = useState(false)
  // Срок «Удаленного» (TRASH_KEEP_DAYS) — числом, как в макете.
  const trash = useQuery({
    queryKey: ['trash', shop.id, 1],
    queryFn: () => api.listTrash(shop.id, 1),
    enabled: deletingAlbum,
  })
  const keepDays = trash.data?.keep_days
  const removeAlbum = useMutation({
    mutationFn: () => api.deleteAlbum(shop.id, albumId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
      void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
      if (album) setFlash({ text: `Альбом «${album.title}» перемещён в «Удаленное»`, undoAlbumId: album.id })
      void navigate({ to: '/albums' })
    },
    onError: () => {
      setDeletingAlbum(false)
      setToast({ text: 'Не удалось удалить альбом. Проверьте интернет' })
    },
  })

  // «Скачать все фото» и «Скачать» у выбранных (макет 13 · «Готовим архив»,
  // «Не удалось подготовить архив»). Сначала спрашиваем сервер, есть ли из
  // чего собирать: скачивание идёт обычным переходом по ссылке, и отказ
  // там продавец увидел бы пустой вкладкой, а не сообщением.
  // Одно выбранное фото сервер отдаёт файлом — без тоста про архив.
  const download = async (ids?: string[]) => {
    const single = ids?.length === 1
    const count = ids?.length ?? album?.photo_count ?? total
    if (!single) {
      setToast({ text: count ? `Готовим архив из ${count} фото…` : 'Готовим архив…', spin: true })
    }
    try {
      await api.checkAlbumDownload(shop.id, albumId, ids)
      const link = document.createElement('a')
      link.href = api.albumDownloadUrl(shop.id, albumId, ids)
      link.download = ''
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Скачивание стартовало — тост больше не нужен.
      setToast(null)
    } catch (e) {
      setToast({
        text: `${single ? 'Не удалось скачать фото' : 'Не удалось подготовить архив'}: ${errorText(e)}`,
        retry: () => void download(ids),
        sticky: true,
      })
    }
  }

  // Перетаскивание файлов на страницу (макет 13 · «Перетаскивание фото»).
  // Счётчик, а не флаг: dragleave срабатывает на каждом вложенном элементе.
  const [dragDepth, setDragDepth] = useState(0)
  // Плитку фото браузер тоже может объявить «файлом» (внутри неё <img>),
  // поэтому перестановку отличаем по своему типу данных.
  const hasFiles = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('application/x-katalog-photo')
  const dropFiles = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragDepth(0)
    void startUpload(Array.from(e.dataTransfer.files))
  }

  // Порции приходят по смещению: если между запросами в альбом что-то
  // добавили, одно фото может попасть в две соседние — повторы убираем.
  const loaded = [...new Map((photos.data?.pages ?? []).flatMap((pg) => pg.photos).map((p) => [p.id, p])).values()]

  // «Сделать обложкой» — фото переезжает на первое место (макет 13):
  // обложка альбома — его первое фото. Явно выбранную раньше обложку
  // сбрасываем, иначе она перекрыла бы порядок.
  const setCover = useMutation({
    mutationFn: async (photoId: string) => {
      // Загруженная часть ленты — всегда начало альбома, поэтому порядок
      // «это фото, затем всё загруженное» ставит его первым во всём альбоме.
      const ids = loaded.map((p) => p.id)
      await api.setPhotoOrder(shop.id, albumId, [photoId, ...ids.filter((id) => id !== photoId)])
      if (album?.cover_photo_id) await api.updateAlbum(shop.id, albumId, { cover_photo_id: '' })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] })
    },
    onError: () => setToast({ text: 'Не удалось сменить обложку. Проверьте интернет' }),
  })

  // Перестановка перетаскиванием (макет 13: «Перетащите фото, чтобы
  // поменять порядок»). Порядок показываем сразу, не дожидаясь сервера:
  // плитка, которая после броска прыгает обратно на секунду, читается
  // как «не сработало».
  const [dragId, setDragId] = useState<string | null>(null)
  const [localOrder, setLocalOrder] = useState<string[] | null>(null)
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.setPhotoOrder(shop.id, albumId, ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
    onError: () => setToast({ text: 'Не удалось сохранить порядок. Проверьте интернет' }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['photos', shop.id, albumId] }).then(() => setLocalOrder(null)),
  })
  const shown = localOrder
    ? localOrder.map((id) => loaded.find((p) => p.id === id)).filter((p): p is Photo => Boolean(p))
    : loaded
  const dropOn = (targetId: string, sourceId = dragId) => {
    if (!sourceId || sourceId === targetId) return
    const ids = shown.map((p) => p.id).filter((id) => id !== sourceId)
    ids.splice(ids.indexOf(targetId), 0, sourceId)
    setDragId(null)
    setLocalOrder(ids)
    reorder.mutate(ids)
  }
  // «Выбрать все» выбирает весь альбом (макет 13), а не только то, что
  // успело подгрузиться: сначала дочитываем ленту до конца.
  const allPicked = shown.length > 0 && !hasNextPage && shown.every((p) => picked.has(p.id))
  const [pickingAll, setPickingAll] = useState(false)
  const toggleAll = async () => {
    if (allPicked) {
      setPicked(new Set())
      return
    }
    let ids = shown.map((p) => p.id)
    if (hasNextPage) {
      setPickingAll(true)
      try {
        let res = await fetchNextPage()
        while (res.hasNextPage && !res.isError) res = await fetchNextPage()
        ids = (res.data?.pages ?? []).flatMap((pg) => pg.photos.map((p) => p.id))
      } finally {
        setPickingAll(false)
      }
    }
    setPicked(new Set(ids))
  }
  // Адрес витрины по слагу; пока список альбомов грузится — старый вид
  // /a/{uuid}, витрина редиректит его на слаг.
  const albumUrl = `${location.origin}/${shop.slug}/${album?.slug ?? `a/${albumId}`}`
  // Пустой альбом (макет 13 · «Пустой альбом»): без статистики и строки
  // выбора — только большая зона загрузки.
  const empty = total === 0 && pending.length === 0
  // Что сказать над сеткой вместо подсказки про порядок: лимит, ход
  // загрузки или ошибки на плитках (макет 13 · «Загрузка», «Ошибки», «Лимит»).
  const status = limit ? (
    <LimitError head={limit.head} excess={limit.excess} hint={limit.hint} />
  ) : uploading ? (
    <span className="alhead__loading">
      <Icon as={LoaderCircle} className="spin" />
      Загружается {pending.filter((p) => !p.error).length} фото · {upDone} готово
    </span>
  ) : failedTiles > 0 ? (
    <p className="limerr" role="alert">
      <Icon as={CircleAlert} size={16} />
      <span>
        <b>
          {failedTiles} фото не {plural(failedTiles, 'загрузилось', 'загрузились', 'загрузились')} · JPEG, PNG, WebP или HEIC до 10 МБ
        </b>
      </span>
    </p>
  ) : null
  const views = stats.data?.views_week
  // «+12% к прошлой неделе» из макета: сравнить есть с чем, только если
  // на прошлой неделе альбом вообще смотрели.
  const prevViews = stats.data?.views_prev_week ?? 0
  const viewsDelta = views !== undefined && prevViews > 0 ? Math.round(((views - prevViews) / prevViews) * 100) : null
  // Знак этого альбома; если своего нет — общий знак магазина.
  const watermark = album?.watermark ?? shopWatermark(shop)
  const category =
    (album?.category_ids ?? [])
      .map((id) => categories.data?.find((c) => c.id === id)?.title)
      .filter(Boolean)
      .join(', ') || undefined

  // Альбом удалён или ссылка чужая/битая: раньше открывался пустой каркас
  // с рабочими кнопками «Загрузить фото» и «Редактировать».
  if (albums.data && !album) {
    return (
      <div className="emptybox">
        <div className="emptybox__ico" aria-hidden="true">
          <Icon as={Folder} size={28} />
        </div>
        <h2>Альбом не найден</h2>
        <p>Возможно, его удалили — удалённые альбомы какое-то время лежат в «Удаленном».</p>
        <div className="mt-4 flex justify-center gap-2">
          <Link to="/albums" className="btn btn--primary">
            К альбомам
          </Link>
          <Link to="/trash" className="btn btn--ghost">
            Открыть «Удаленное»
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div
      className="alpage"
      onDragEnter={(e) => hasFiles(e) && setDragDepth((d) => d + 1)}
      onDragLeave={(e) => hasFiles(e) && setDragDepth((d) => Math.max(0, d - 1))}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={dropFiles}
    >
      {dragDepth > 0 && (
        <div className="alpage__drop" aria-hidden="true">
          <div>
            <i>
              <Icon as={Upload} size={24} />
            </i>
            <b>Отпустите, чтобы загрузить в «{album?.title ?? 'альбом'}»</b>
            <small>{FORMATS_HINT} · можно сразу несколько</small>
          </div>
        </div>
      )}
      {toast && (
        <Toast
          text={toast.text}
          spin={toast.spin}
          actions={[
            ...(toast.undo
              ? [
                  {
                    label: 'Отменить',
                    run: () => {
                      toast.undo?.()
                      setToast(null)
                    },
                  },
                ]
              : []),
            ...(toast.retry ? [{ label: 'Повторить', run: toast.retry }] : []),
          ]}
          onClose={() => setToast(null)}
        />
      )}
      {access && album && (
        <AccessDialog
          shopId={shop.id}
          plan={shop.plan}
          albums={[album]}
          onClose={(done) => {
            setAccess(false)
            if (!done) return
            void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
            setToast({ text: done })
          }}
        />
      )}
      {deletingAlbum && album && (
        <Portal><div className="modal__back" role="alertdialog" aria-modal="true" aria-label="Удаление альбома">
          <div className="modal modal--sm al__confirm">
            <span className="confirm__ico" aria-hidden="true">
              <Icon as={Trash2} size={22} />
            </span>
            <div className="modal__head">
              <h2>Удалить альбом «{album.title}»?</h2>
            </div>
            <p className="modal__text">
              {album.photo_count > 1
                ? `Альбом и все ${album.photo_count.toLocaleString('ru-RU')} фото в нём переместятся`
                : 'Альбом вместе с содержимым переместится'}{' '}
              в «Удаленное». Там их можно восстановить{' '}
              {keepDays ? `в течение ${keepDays} ${plural(keepDays, 'дня', 'дней', 'дней')}` : 'пока не истечёт срок хранения'}.
            </p>
            <div className="modal__foot">
              <span className="spacer" />
              <button className="btn btn--ghost" onClick={() => setDeletingAlbum(false)} disabled={removeAlbum.isPending} autoFocus>
                Отмена
              </button>
              <button className="btn btn--primary" onClick={() => removeAlbum.mutate()} disabled={removeAlbum.isPending}>
                {removeAlbum.isPending ? 'Удаляем…' : 'Удалить'}
              </button>
            </div>
          </div>
        </div></Portal>
      )}
      {sharing && album && (
        <ShareDialog
          title="Поделиться альбомом"
          lead="Отправьте ссылку покупателю"
          label="Ссылка на альбом"
          url={albumUrl}
          // Черновик по ссылке не открывается: сказать об этом нужно до
          // того, как продавец разошлёт адрес.
          note={
            album.blocked_by_moderator
              ? 'Альбом скрыт модератором — по ссылке он сейчас не откроется'
              : album.status === 'draft'
                ? 'Альбом в черновиках — покупатель его не увидит, пока вы не опубликуете'
                : album.has_password
                  ? 'Альбом защищён паролем — покупатель введёт его при открытии'
                  : 'Альбом без пароля — откроется у всех, у кого есть ссылка'
          }
          noteIcon={album.has_password && !album.blocked_by_moderator && album.status !== 'draft' ? 'lock' : 'info'}
          onClose={() => setSharing(false)}
        />
      )}
      <nav className="alpage__crumbs" aria-label="Навигационная цепочка">
        <Link to="/albums">
          <Icon as={ChevronLeft} />
          Альбомы
        </Link>
        <span>/</span>
        <span>{album?.title ?? 'Альбом'}</span>
      </nav>

      {/* Шапка альбома. На десктопе действия справа от названия, на телефоне
          (макет 13 · Mobile) — под описанием: «Загрузить фото» во всю
          ширину, ниже «Поделиться», «Редактировать» и «⋯». */}
      <div className="alpage__head">
      <div className="alpage__top">
        <h1>{album?.title ?? 'Альбом'}</h1>
        {album && <span className={STATUS[album.status].cls}>{STATUS[album.status].label}</span>}
        {album?.has_password && (
          <span className="badge badge--lock">
            <Icon as={Lock} size={13} />С паролем
          </span>
        )}
        {album?.blocked_by_moderator && <span className="badge badge--warn">Скрыт модератором</span>}
      </div>
      <div className="alpage__acts">
        <button className="btn btn--ghost btn--sm alpage__share" onClick={() => setSharing(true)} disabled={!album}>
          <Icon as={Share2} size={18} />
          Поделиться
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setEditing('form')} disabled={!album}>
          <Icon as={Pen} size={18} />
          Редактировать
        </button>
        <button className="btn btn--primary btn--sm alpage__upload" onClick={() => fileInput.current?.click()}>
          <Icon as={Upload} size={18} strokeWidth={2} />
          Загрузить фото
        </button>
        {/* Макет 13: в шапке три кнопки и «⋯». */}
        <Popover open={menuOpen} onToggle={setMenuOpen} label="Ещё" title="Ещё действия" plain icon={<Icon as={Ellipsis} size={18} />}>
          <div className="popmenu" role="menu" onClick={() => setMenuOpen(false)}>
            <button role="menuitem" onClick={() => setAccess(true)} disabled={!album || album.blocked_by_moderator}>
              <Icon as={Lock} size={18} />
              Изменить доступ
            </button>
            <button role="menuitem" onClick={() => void download()} disabled={!album || album.photo_count === 0}>
              <Icon as={Download} size={18} />
              Скачать все фото
            </button>
            <hr className="popmenu__sep" />
            <button role="menuitem" onClick={() => setDeletingAlbum(true)} disabled={!album}>
              <Icon as={Trash2} size={18} />
              Удалить альбом
            </button>
          </div>
        </Popover>
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

      {album?.description ? (
        <p className="alpage__desc">{album.description}</p>
      ) : (
        album && (
          // Макет 13 · «Пустой альбом»: описания нет — ссылка, чтобы добавить.
          <p className="alpage__desc">
            <button className="font-medium text-brand" onClick={() => setEditing('form')}>
              + Добавить описание
            </button>
          </p>
        )
      )}
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

      {/* Бесплатный (макет 13 · «Бесплатный тариф»): вместо статистики
          и блока «Водяной знак» — заглушка со ссылкой на тарифы. */}
      {empty ? null : shop.plan === 'free' ? (
        <PaidLock />
      ) : (
      <div className="alstats">
        <div className="alstat">
          <span>Просмотры за 7 дней</span>
          {views === undefined ? (
            <em>{stats.isError ? 'не удалось загрузить' : '…'}</em>
          ) : (
            <>
              <b>{views.toLocaleString('ru-RU')}</b>
              {viewsDelta !== null && viewsDelta !== 0 && (
                <em>
                  <span className={viewsDelta > 0 ? 'up' : ''}>
                    {viewsDelta > 0 ? '+' : ''}
                    {viewsDelta}%
                  </span>{' '}
                  к прошлой неделе
                </em>
              )}
            </>
          )}
        </div>
        <div className="alstat">
          <span>Переходы в мессенджер</span>
          {stats.data ? (
            <>
              <b>{stats.data.lead_clicks.toLocaleString('ru-RU')}</b>
              <em>за 7 дней</em>
            </>
          ) : (
            <em>{stats.isError ? 'не удалось загрузить' : '…'}</em>
          )}
        </div>
        <div className="alstat">
          <span>Водяной знак</span>
          <b className="alstat__wm">{watermark?.enabled ? 'Включён' : 'Выключен'}</b>
          <button className="alstat__link" onClick={() => setEditing('wm')} disabled={!album}>
            Настроить
          </button>
        </div>
      </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          // Список копируем сразу: после сброса value FileList пустеет.
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          void startUpload(files)
        }}
      />
      <div className="alhead" hidden={empty}>
        <SelectAll
          picked={picked.size}
          all={allPicked}
          onToggle={() => void toggleAll()}
          disabled={shown.length === 0 || pickingAll || ordering}
        />
        {picked.size > 0 && (
          <>
            <button className="alhead__act alhead__act--wide" onClick={() => void download([...picked])}>
              <Icon as={Download} />
              Скачать
            </button>
            <button className="alhead__act alhead__act--wide" onClick={() => remove.mutate([...picked])}>
              <Icon as={Trash2} />
              Удалить
            </button>
            <button className="alhead__act alhead__act--narrow" onClick={() => setPicked(new Set())}>
              Снять выбор
            </button>
            {/* Телефон (макет 13 · Mobile · «Выбраны фото»): действия —
                закреплённой панелью внизу. */}
            <div className="selbar">
              <button className="btn btn--primary" onClick={() => void download([...picked])}>
                <Icon as={Download} size={18} />
                Скачать
              </button>
              <button className="btn btn--primary" onClick={() => remove.mutate([...picked])}>
                <Icon as={Trash2} size={18} />
                Удалить
              </button>
            </div>
          </>
        )}
        <span className="spacer" />
        {status && <span className="ap__status">{status}</span>}
        {shown.length > 1 && !status && (
          <span className="alhead__tip">
            <Icon as={GripVertical} size={14} />
            Перетащите фото, чтобы поменять порядок
          </span>
        )}
        {shown.length > 1 && (
          <button className="alhead__order" aria-pressed={ordering} onClick={() => setOrdering((v) => !v)}>
            <Icon as={ordering ? Check : GripVertical} size={14} />
            {ordering ? 'Готово' : 'Изменить порядок'}
          </button>
        )}
        {!status && (
          total !== undefined && (
            <span className="alhead__count">
              {album?.photo_count ?? total} фото
              {failedCount > 0 && ` · ${failedCount} не ${plural(failedCount, 'обработано', 'обработаны', 'обработаны')}`}
            </span>
          )
        )}
      </div>
      {/* Сенсорный экран (макет 13 · Tablet/Mobile): подсказка — под строкой
          выбора, отдельной строкой. */}
      {shown.length > 0 && (
        <p className="alhead__tip-touch">
          <Icon as={Info} size={14} />
          {ordering
            ? 'Перетащите фото за ручку, чтобы поменять порядок. Первое фото — обложка'
            : 'Чтобы удалить или изменить обложку, нажмите на фото'}
        </p>
      )}
      {/* Телефон (макет 13 · Mobile): тот же статус — под подсказкой. */}
      {status && <div className="ap__status-m">{status}</div>}

      {photos.isPending && <p className="text-ink-2">Загрузка…</p>}
      {photos.isError && <p className="text-danger" role="alert">Не удалось загрузить фото.</p>}

      {/* Пустой альбом (макет 13 · «Пустой альбом-черновик»): вместо сетки
          большая зона загрузки, у черновика — плашка с «Изменить доступ». */}
      {total === 0 && album?.status === 'draft' && (
        <div className="ap__draft">
          <Icon as={Info} size={18} />
          <span>
            Альбом в черновике — покупатели его не видят. <button onClick={() => setAccess(true)}>Изменить доступ</button>
          </span>
        </div>
      )}
      {empty && (
        // Вся зона нажимается; «Выбрать файлы» — видимая кнопка внутри неё.
        <div className="bigdrop" onClick={() => fileInput.current?.click()}>
          <i aria-hidden="true">
            <Icon as={ImagePlus} size={28} />
          </i>
          <b>В альбоме пока нет фото</b>
          <span className="hover-only">Перетащите фото сюда или выберите файлы на компьютере</span>
          <span className="touch-only-inline">Нажмите «Выбрать файлы» — из галереи, файлов или камеры</span>
          <button type="button" className="btn btn--primary btn--sm">
            <Icon as={Upload} size={18} strokeWidth={2} />
            Выбрать файлы
          </button>
          <small>{FORMATS_HINT} · можно сразу несколько</small>
        </div>
      )}

      <div
        ref={gallery}
        className={`algallery ${ordering ? 'algallery--order' : ''}`}
        hidden={empty}
      >
        {/* Плитка загрузки — первой в сетке, как в макете. */}
        <button className="uptile" hidden={ordering} onClick={() => fileInput.current?.click()}>
          <i aria-hidden="true">
            <Icon as={Plus} size={20} />
          </i>
          <span>Загрузить фото</span>
          <small className="hover-only">или перетащите сюда</small>
          <small className="touch-only-inline">из галереи или камеры</small>
        </button>
        {shown.map((p, i) => (
          <Fragment key={p.id}>
          <PhotoTile
            key={p.id}
            photo={p}
            dragging={dragId === p.id}
            // Метку «тащат» — в следующем тике: перерисовка плитки прямо в
            // dragstart обрывала перетаскивание в Chrome.
            onDragStart={() => setTimeout(() => setDragId(p.id), 0)}
            onDragEnd={() => setDragId(null)}
            onDropHere={() => dropOn(p.id)}
            isCover={album?.cover_photo_id ? album.cover_photo_id === p.id : shown[0]?.id === p.id}
            picked={picked.has(p.id)}
            onPick={() => {
              const next = new Set(picked)
              if (next.has(p.id)) next.delete(p.id)
              else next.add(p.id)
              setPicked(next)
            }}
            onSetCover={() => setCover.mutate(p.id)}
            onDelete={() => remove.mutate([p.id])}
            handle={ordering ? photoReorder.handle(p.id, (from, to) => dropOn(to, from)) : undefined}
            menu={menu?.id === p.id && !ordering ? menu : null}
            onMenu={(right) => setMenu((cur) => (cur?.id === p.id ? null : { id: p.id, right }))}
            onMenuClose={() => setMenu(null)}
            over={photoReorder.over === p.id}
          />
          {/* Новые фото встают сразу после обложки — там и их плитки. */}
          {i === 0 && pending.map((u) => <PendingTile key={u.key} item={u} onRetry={() => retryPending(u.key)} onDismiss={() => setPending((prev) => prev.filter((x) => x.key !== u.key))} />)}
          </Fragment>
        ))}
        {shown.length === 0 &&
          pending.map((u) => (
            <PendingTile
              key={u.key}
              item={u}
              onRetry={() => retryPending(u.key)}
              onDismiss={() => setPending((prev) => prev.filter((x) => x.key !== u.key))}
            />
          ))}
      </div>

      {/* Сторож бесконечной прокрутки. Альбом может содержать тысячи
          фотографий — грузить их разом значит несколько секунд пустых плиток. */}
      <div ref={sentinel} aria-hidden="true" />
      {isFetchingNextPage && <p className="mt-4 text-center text-sm text-ink-2">Загружаем ещё фото…</p>}

      {editing && album && (
        <EditAlbumDialog
          shopId={shop.id}
          album={album}
          categories={categories.data ?? []}
          withPhotos={false}
          watermark={editing === 'wm'}
          onClose={(saved) => {
            setEditing(false)
            if (saved) {
              refreshQuota()
              setToast({ text: 'Изменения сохранены' })
              // Счётчик и обложку альбом получает после обработки новых фото.
              for (const delay of [3000, 10000]) {
                setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] }), delay)
              }
            }
          }}
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
  dragging,
  onDragStart,
  onDragEnd,
  onDropHere,
  onDelete,
  onSetCover,
  onPick,
  isCover,
  picked,
  handle,
  over,
  menu,
  onMenu,
  onMenuClose,
}: {
  // Меню фото на тач-экране открыто у этой плитки; right — раскрыть влево.
  menu: { right: boolean } | null
  onMenu: (right: boolean) => void
  onMenuClose: () => void
  // Режим «Изменить порядок»: ручка для перетаскивания указателем.
  handle?: React.HTMLAttributes<HTMLElement>
  // Сюда встанет перетаскиваемое фото — подсветка пунктиром.
  over?: boolean
  photo: Photo
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDropHere: () => void
  onDelete: () => void
  onSetCover: () => void
  onPick: () => void
  isCover: boolean
  picked: boolean
}) {
  return (
    <figure
      className={`group relative overflow-hidden rounded-[10px] bg-surface-alt ${dragging ? 'is-dragging' : ''} ${over ? 'photo--over' : ''} ${picked ? 'is-picked' : ''} ${menu ? 'is-menu' : ''}`}
      data-photo-id={photo.id}
      title={photo.caption || undefined}
      draggable={!handle}
      // Клик по фото — выбор (макет 13); кнопки на фото работают сами по себе.
      onClick={(e) => {
        if (handle || (e.target as HTMLElement).closest('button, input, a, [role="menu"]')) return
        if (window.matchMedia('(hover: none)').matches) onMenu(tileOnRight(e.currentTarget))
        else onPick()
      }}
      onDragStart={(e) => {
        // Свой тип данных: по нему страница отличает перестановку плиток
        // от файлов, которые тащат с компьютера для загрузки.
        e.dataTransfer.setData('application/x-katalog-photo', photo.id)
        e.dataTransfer.effectAllowed = 'move'
        setLiftedDragImage(e)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-katalog-photo')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('application/x-katalog-photo')) return
        e.preventDefault()
        e.stopPropagation()
        onDropHere()
      }}
    >
      {handle ? (
        <button className="photo__handle" aria-label="Перетащить фото" {...handle}>
            <Icon as={GripVertical} size={14} />
          </button>
      ) : (
        <input
          type="checkbox"
          className="alcard__pick"
          checked={picked}
          onChange={onPick}
          aria-label="Выбрать фото"
        />
      )}
      {menu && (
        <TileMenu
          right={menu.right}
          onCover={!isCover && photo.status === 'ready' ? onSetCover : undefined}
          onRemove={onDelete}
          onDone={onMenuClose}
        />
      )}
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
      {/* Плитка квадратная, без подписи под фото (макет 13): полоса с
          подписью была не у всех фото, ряды выходили с пустыми хвостами, а
          «Обложка» ложилась поверх текста. Подпись — в подсказке и в alt;
          править её — в «Подписи ко всем фото». */}
      {/* Обложка — то, что покупатель видит в сетке альбомов. Без выбора
          ею всегда оказывалось первое загруженное фото. */}
      {photo.status === 'ready' &&
        (isCover || handle ? (
          isCover && (
            <span className="photo__badge">Обложка</span>
          )
        ) : (
          <button onClick={onSetCover} className="photo-tile__act photo__setcover hidden group-hover:block">
            Сделать обложкой
          </button>
        ))}
      {/* Один тап: фото уходит в «Удаленное», и тут же предлагается
          «Отменить». Второй тап был нужен, пока удаление было необратимым. */}
      <button
        hidden={Boolean(handle)}
        onClick={onDelete}
        title="Удалить"
        aria-label="Удалить фото"
        className="photo-tile__act photo__del"
      >
        <Icon as={X} size={14} />
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
  file_too_large: 'Файл больше 10 МБ',
  empty: 'Пустой файл',
  // Не про файл, а про нас: задача обработки потерялась. Винить в этом
  // фотографию продавца нельзя — он начнёт искать проблему там, где её нет.
  lost: 'Обработка не завершилась — загрузите файл заново',
}

function StatusBadge({ status, reason }: { status: Photo['status']; reason?: string }) {
  // Иконка над текстом — как у плиток с ошибкой загрузки (макет 13 ·
  // «Ошибки загрузки фото»).
  if (status === 'processing' || status === 'uploading') {
    return (
      <span className="photo__state">
        <Icon as={LoaderCircle} size={20} className="spin" />
        Обработка…
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="photo__state photo__state--bad" title={FAIL_TEXT[reason ?? ''] ?? 'Причина неизвестна'}>
        <Icon as={CircleAlert} size={20} />
        {FAIL_TEXT[reason ?? ''] ?? 'Не удалось обработать'}
      </span>
    )
  }
  if (status === 'blocked') {
    return (
      <span className="photo__state photo__state--bad">
        <Icon as={EyeOff} size={20} />
        Скрыто модератором
      </span>
    )
  }
  // Осталось только ready без готовых деривативов: файл принят, ссылок ещё нет.
  return (
    <span className="photo__state">
      <Icon as={LoaderCircle} size={20} className="spin" />
      Готовим…
    </span>
  )
}

// Плитка фото, которое ещё грузится: превью, проценты и полоса; не
// доехавшее — с причиной и крестиком.
function PendingTile({
  item,
  onRetry,
  onDismiss,
}: {
  item: { file: File; pct: number; error?: string; reject?: boolean }
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <figure className={`uptile2 ${item.error === 'Ошибка сети' ? 'uptile2--net' : item.error ? 'uptile2--bad' : ''}`}>
      {/* Отклонённый файл — без превью: картинку браузер может и не показать. */}
      {!item.reject && <Thumb file={item.file} />}
      {item.error ? (
        <>
          <span className="uptile2__msg">
            <Icon as={item.error === 'Ошибка сети' ? WifiOff : CircleAlert} size={20} />
            <b>{item.error}</b>
            {/* Сеть — повод повторить; тариф — нет, там нужен другой тариф. */}
            {item.reject && <small title={item.file.name}>{item.file.name}</small>}
            {item.error === 'Ошибка сети' && (
              <button className="uptile2__retry" onClick={onRetry}>
                <Icon as={RefreshCw} size={13} />
                Повторить
              </button>
            )}
          </span>
          <button className="uptile2__x" onClick={onDismiss} aria-label="Убрать">
            <Icon as={X} />
          </button>
        </>
      ) : (
        // Затемнённая плитка, крупный процент и полоса (макет 13 · «Загрузка фото»).
        <span className="uptile2__up">
          <b>{item.pct}%</b>
          <i style={{ '--p': `${item.pct}%` } as CSSProperties} />
        </span>
      )}
    </figure>
  )
}
