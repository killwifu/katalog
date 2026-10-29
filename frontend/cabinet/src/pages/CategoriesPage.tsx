import { Check, ChevronDown, Image as ImageIcon, ChevronLeft, ChevronRight, ChevronUp, Ellipsis, Eye, EyeOff as EyeOffIcon, FolderPlus, FolderTree, GripVertical, Inbox, Info, Pen, Plus, Search, Trash2, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, type Album, type Category } from '../api'
import { usePointerReorder } from '../lib/pointerReorder'
import { HomeIcon, Icon } from '../lib/icons'
import { Popover } from './Popover'
import { useShop } from './AppLayout'
import { SelectAll } from './SelectAll'
import { Toast } from './Toast'
import { useSingleFlight } from '../lib/singleFlight'
import { fold } from '../lib/fold'
import { useDialogClose } from '../lib/useDialogClose'
import { Portal } from '../lib/Portal'
import { useFlip } from '../lib/flip'

// Слаг из названия: кириллица транслитом, всё прочее — в дефис.
// Пользователь может поправить руками, поле открыто.
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .split('')
    .map((ch) => MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    // Обрезаем раньше, чем снимаем хвостовой дефис: наоборот срез сам его
    // и оставлял. Название «Женская и мужская обувь и сумки из Кореи оптом
    // и в розницу» давало slug, кончающийся дефисом, — сервер такой адрес
    // не принимает, и продавец на первом же экране онбординга получал
    // ошибку в поле, которое заполнили за него. 63 — длина, которая
    // проходит серверную проверку при любом числе дефисов.
    .slice(0, 63)
    .replace(/-+$/, '')
}

// Категории по макету 14 · Desktop: слева дерево, справа содержимое
// выбранной категории. Плоский список не отвечал на главный вопрос —
// что лежит внутри: приходилось открывать альбомы и смотреть у каждого.
export function CategoriesPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })

  // undefined — продавец ещё ничего не выбирал: открыта первая категория
  // (макет 14 · «Основной»), а не «Без категории».
  const [chosen, setSelected] = useState<string | null | undefined>(undefined)
  // Раскрытые категории верхнего уровня (шеврон в дереве, макет 14).
  const [openState, setOpenState] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null)
  // Категория, которую переименовывают прямо в строке дерева.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<string>('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Какие альбомы собираются убрать из категории — ждёт подтверждения.
  const [removing, setRemoving] = useState<{ list: Album[]; from: string; ids: string[] } | null>(null)
  // Перетаскивание (макет 14 · «Перетаскивание», «Перетаскивание альбома»):
  // категорию тянут по дереву, чтобы поменять порядок на витрине; альбом —
  // на строку дерева, чтобы положить его в эту категорию.
  const [drag, setDrag] = useState<{ kind: 'category' | 'album'; id: string } | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  // Альбомы из «Без категории», которые раскладывают по категориям.
  const [placing, setPlacing] = useState<Album[] | null>(null)
  // Уведомление с «Отменить»: убрать альбом из категории — одно нажатие,
  // и вернуть его должно быть не сложнее.
  const [toast, setToast] = useState<{ text: string; undo?: () => void; undoLabel?: string } | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), toast.undo ? 10000 : 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['categories', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
  }

  // Повторы названий разрешены (макет 14), а адрес категории обязан быть
  // уникальным и не короче трёх символов — добираем его номером.
  const freeSlug = (title: string) => {
    const taken = new Set((categories.data ?? []).map((c) => c.slug))
    let base = slugify(title)
    if (base.length < 3) base = `cat-${base}`.replace(/-+$/, '')
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 58)}-${n}`
    return slug
  }
  const create = useMutation({
    mutationFn: (v: { title: string; parentId: string | null }) =>
      api.createCategory(shop.id, v.title, freeSlug(v.title), v.parentId ?? undefined),
    onSuccess: (c) => {
      setAdding(null)
      setError('')
      setSelected(c.id)
      refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  // Удаление (макет 14 · «Категория удалена»): открывается следующая
  // категория, в тосте — «Отменить». Сервер удаляет насовсем, поэтому
  // «Отменить» собирает категорию заново по снимку: тот же адрес, место,
  // видимость, подкатегории и альбомы в прежнем порядке.
  const removeCategory = async (c: Category) => {
    const list = categories.data ?? []
    const siblings = list.filter((x) => x.parent_id === c.parent_id)
    const i = siblings.findIndex((x) => x.id === c.id)
    const next = siblings[i + 1] ?? siblings[i - 1] ?? list.find((x) => x.id === c.parent_id)
    const snap = [c, ...list.filter((x) => x.parent_id === c.id)].map((cat) => ({
      cat,
      albums: albumsOrdered(cat.id),
    }))
    try {
      await api.deleteCategory(shop.id, c.id)
    } catch (e) {
      setError(errorText(e as Error))
      return
    }
    setError('')
    setSelected(next?.id)
    setChip('')
    setPicked(new Set())
    refresh()
    setToast({
      text: `Категория «${c.title}» удалена`,
      undo: () => void restoreCategory(snap, siblings.map((x) => x.id)),
    })
  }
  const restoreCategory = async (snap: { cat: Category; albums: string[] }[], siblingIds: string[]) => {
    const [root, ...subs] = snap
    try {
      const made = await api.createCategory(shop.id, root.cat.title, root.cat.slug, root.cat.parent_id ?? undefined)
      const ids = new Map([[root.cat.id, made.id]])
      for (const s of subs) ids.set(s.cat.id, (await api.createCategory(shop.id, s.cat.title, s.cat.slug, made.id)).id)
      const now = await api.listCategories(shop.id)
      await saveOrder(
        now.filter((x) => x.parent_id === root.cat.parent_id),
        siblingIds.map((id) => ids.get(id) ?? id),
      )
      await Promise.allSettled(
        snap.flatMap((s) => {
          const id = ids.get(s.cat.id) as string
          const vis =
            s.cat.is_hidden || !s.cat.on_home
              ? [api.setCategoryVisibility(shop.id, id, { is_hidden: s.cat.is_hidden, on_home: s.cat.on_home })]
              : []
          const put = Promise.allSettled(s.albums.map((a) => api.addAlbumToCategory(shop.id, id, a))).then(() =>
            s.albums.length > 1 ? api.setCategoryAlbumOrder(shop.id, id, s.albums) : undefined,
          )
          return [...vis, put]
        }),
      )
      setSelected(made.id)
    } catch {
      setToast({ text: 'Не удалось вернуть категорию. Проверьте интернет' })
    }
    refresh()
  }

  // Убрать альбомы из категории и предложить вернуть. Альбом может лежать
  // в нескольких категориях: убираем только из тех, что входят в открытую
  // (она сама и её подкатегории), остальные не трогаем.
  const unassign = async (list: Album[], from: string, categoryIds: string[]) => {
    const pairs = list.flatMap((a) =>
      (a.category_ids ?? []).filter((id) => categoryIds.includes(id)).map((categoryId) => ({ albumId: a.id, categoryId })),
    )
    // Порядок альбомов в затронутых категориях до удаления: «Отменить»
    // возвращает альбомы на их места, а не в конец категории.
    const orderBefore = new Map<string, string[]>()
    for (const categoryId of new Set(pairs.map((p) => p.categoryId))) orderBefore.set(categoryId, albumsOrdered(categoryId))
    const results = await Promise.allSettled(
      pairs.map((p) => api.removeAlbumFromCategory(shop.id, p.categoryId, p.albumId)),
    )
    const done = pairs.filter((_, i) => results[i].status === 'fulfilled')
    refresh()
    setPicked(new Set())
    if (done.length === 0) {
      setToast({ text: 'Не удалось убрать альбомы. Проверьте интернет' })
      return
    }
    const albumsDone = new Set(done.map((d) => d.albumId)).size
    setToast({
      text:
        list.length === 1
          ? `Альбом «${list[0].title}» убран из «${from}»`
          : `${albumsDone} ${plural(albumsDone, 'альбом убран', 'альбома убраны', 'альбомов убрано')} из «${from}»`,
      undo: () => {
        void Promise.allSettled(done.map((d) => api.addAlbumToCategory(shop.id, d.categoryId, d.albumId)))
          .then(() =>
            Promise.allSettled(
              [...new Set(done.map((d) => d.categoryId))].map((categoryId) => {
                const ids = orderBefore.get(categoryId) ?? []
                return ids.length > 0 ? api.setCategoryAlbumOrder(shop.id, categoryId, ids) : Promise.resolve()
              }),
            ),
          )
          .then(refresh)
      },
    })
  }

  // Адрес категории при переименовании не трогаем: по нему уже могли
  // разойтись ссылки, и менять его молча нельзя.
  const rename = useMutation({
    mutationFn: (v: { id: string; title: string; slug: string; parentId: string | null }) =>
      api.updateCategory(shop.id, v.id, v.title, v.slug, v.parentId),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  // «На главной» и «Скрыть с витрины» из меню категории (макет 14 · «⋯»).
  const visibility = useMutation({
    mutationFn: (v: { category: Category; patch: { is_hidden?: boolean; on_home?: boolean } }) =>
      api.setCategoryVisibility(shop.id, v.category.id, v.patch),
    onSuccess: (_, v) => {
      refresh()
      const back = () =>
        visibility.mutate({
          category: v.category,
          patch: { is_hidden: v.category.is_hidden, on_home: v.category.on_home },
        })
      if (v.patch.on_home === false) {
        setToast({ text: `«${v.category.title}» больше не показывается на главной`, undo: back, undoLabel: 'Вернуть' })
      } else if (v.patch.is_hidden === true) {
        setToast({ text: `«${v.category.title}» скрыта с витрины`, undo: back })
      }
    },
    onError: (e: Error) => setError(errorText(e)),
  })

  // Добавление в категорию не вынимает альбом из остальных.
  const assign = useMutation({
    mutationFn: (v: { albumId: string; categoryId: string }) =>
      api.addAlbumToCategory(shop.id, v.categoryId, v.albumId),
    onSuccess: refresh,
    onError: (e: Error) => setError(errorText(e)),
  })

  // Альбомы категории в её порядке (он же порядок на витрине).
  const albumsOrdered = (categoryId: string) =>
    (albums.data ?? [])
      .filter((a) => (a.category_ids ?? []).includes(categoryId))
      .sort((x, y) => (x.category_pos?.[categoryId] ?? 0) - (y.category_pos?.[categoryId] ?? 0))
      .map((a) => a.id)
  // Номера переписываем всем на уровне подряд — так порядок не зависит от
  // того, какие sort_order стояли раньше. Кого нет в ids — в конец.
  const saveOrder = (level: Category[], ids: string[]) => {
    const rank = (c: Category) => (ids.includes(c.id) ? ids.indexOf(c.id) : ids.length)
    const sorted = [...level].sort((x, y) => rank(x) - rank(y))
    return Promise.allSettled(
      sorted.map((c, i) => (c.sort_order === i ? null : api.updateCategory(shop.id, c.id, c.title, c.slug, c.parent_id, i))),
    )
  }
  // Порядок внутри уровня (категории или подкатегории одной категории):
  // перетащенная встаёт на место той, на которую её бросили, — ниже неё,
  // если тянули вниз, и выше, если вверх (так её можно поставить и последней).
  const reorderCategories = async (movingId: string, targetId: string) => {
    const list = categories.data ?? []
    const moving = list.find((c) => c.id === movingId)
    if (!moving || movingId === targetId) return
    const level = list.filter((c) => c.parent_id === moving.parent_id)
    const ids = level.map((c) => c.id)
    const down = ids.indexOf(movingId) < ids.indexOf(targetId)
    const rest = ids.filter((id) => id !== movingId)
    rest.splice(rest.indexOf(targetId) + (down ? 1 : 0), 0, movingId)
    const results = await saveOrder(level, rest)
    refresh()
    if (results.some((r) => r.status === 'rejected')) setToast({ text: 'Не удалось сохранить порядок категорий' })
  }
  const dropOnCategory = (target: Category, what = drag) => {
    setDrag(null)
    setDropOn(null)
    if (!what) return
    if (what.kind === 'album') {
      const album = (albums.data ?? []).find((a) => a.id === what.id)
      if (album && !(album.category_ids ?? []).includes(target.id)) {
        assign.mutate(
          { albumId: album.id, categoryId: target.id },
          { onSuccess: () => setToast({ text: `Альбом «${album.title}» добавлен в «${target.title}»` }) },
        )
      }
    } else {
      const moving = (categories.data ?? []).find((c) => c.id === what.id)
      if (!moving) return
      // Соседи по уровню — меняется порядок. Подкатегорию бросили на другую
      // категорию (или её подкатегорию) — она переезжает туда (макет 14).
      if (moving.parent_id === target.parent_id) {
        void reorderCategories(moving.id, target.id)
      } else if (moving.parent_id) {
        const parent = target.parent_id ?? target.id
        if (moving.parent_id !== parent) {
          const title = (categories.data ?? []).find((c) => c.id === parent)?.title
          rename.mutate(
            { id: moving.id, title: moving.title, slug: moving.slug, parentId: parent },
            { onSuccess: () => setToast({ text: `«${moving.title}» перенесена в «${title}»` }) },
          )
        }
      }
    }
  }
  // Куда встанет строка — синей линией (сосед по уровню) или подсветкой
  // (подкатегория переезжает в эту категорию, альбом ложится в неё).
  const dropMark = (c: Category): 'above' | 'below' | 'into' | undefined => {
    const over = dropOn === c.id || treeReorder.over === c.id
    const from = drag?.kind === 'category' ? drag.id : treeReorder.dragging
    if (!over) return undefined
    if (drag?.kind === 'album') return 'into'
    const moving = all.find((x) => x.id === from)
    if (!moving || moving.parent_id !== c.parent_id) return 'into'
    const level = all.filter((x) => x.parent_id === c.parent_id)
    return level.indexOf(moving) < level.indexOf(c) ? 'below' : 'above'
  }
  const dropProps = (c: Category) => ({
    onDragOver: (e: React.DragEvent) => {
      // Категорию верхнего уровня — только к соседям (третьего уровня нет).
      if (!drag || (drag.kind === 'category' && (drag.id === c.id || (c.parent_id && !all.find((x) => x.id === drag.id)?.parent_id)))) return
      e.preventDefault()
      setDropOn(c.id)
    },
    onDragLeave: () => setDropOn((cur) => (cur === c.id ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dropOnCategory(c)
    },
  })

  // Порядок показываем сразу, не дожидаясь сервера: карточка, которая после
  // броска прыгает обратно, читается как «не сработало».
  const [dropAlbum, setDropAlbum] = useState<string | null>(null)
  const [localPos, setLocalPos] = useState<Record<string, number> | null>(null)
  const reorderAlbums = useMutation({
    mutationFn: (v: { categoryId: string; ids: string[] }) => api.setCategoryAlbumOrder(shop.id, v.categoryId, v.ids),
    onError: () => setToast({ text: 'Не удалось сохранить порядок. Проверьте интернет' }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['albums', shop.id] }).then(() => setLocalPos(null)),
  })

  // «Изменить порядок» на планшете и телефоне (макет 14): отдельно для
  // дерева (под ним) и для альбомов (над сеткой).
  const [treeOrdering, setTreeOrdering] = useState(false)
  const [paneOpen, setPaneOpen] = useState(false)
  const [albumOrdering, setAlbumOrdering] = useState(false)
  const [narrow] = useState(() => window.matchMedia('(max-width: 1199px)').matches)
  const treeReorder = usePointerReorder('cat-id')
  const albumReorder = usePointerReorder('album-id')
  // Перестановка категорий и альбомов — плавным переездом строк и карточек.
  const treeRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  useFlip(treeRef, 'cat-id')
  useFlip(gridRef, 'album-id')
  const dropCategoryById = (from: string, to: string) => {
    const target = (categories.data ?? []).find((c) => c.id === to)
    if (target) dropOnCategory(target, { kind: 'category', id: from })
  }

  if (categories.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (categories.isError) return <p className="text-danger" role="alert">Не удалось загрузить категории.</p>

  const all = categories.data
  const roots = all.filter((c) => !c.parent_id)
  const children = (id: string) => all.filter((c) => c.parent_id === id)
  const selected = chosen === undefined ? (roots[0]?.id ?? null) : chosen
  // Категорий ещё нет и продавец ничего не выбирал (макет 14 · «Нет
  // категорий»): справа — приглашение создать первую, а не «Без категории».
  const noneYet = roots.length === 0 && chosen === undefined
  // Раскрыта та, что выбрана (или чья подкатегория выбрана), и те, что
  // продавец раскрыл шевроном.
  const selectedRoot = selected ? (all.find((c) => c.id === selected)?.parent_id ?? selected) : null
  const isOpen = (id: string) => openState[id] ?? id === selectedRoot
  const toggleOpen = (id: string) => setOpenState((prev) => ({ ...prev, [id]: !isOpen(id) }))
  const albumList = albums.data ?? []
  // В категорию считаем и альбомы её подкатегорий: в макете у родителя
  // стоит сумма, а не только то, что лежит прямо в нём.
  const idsOf = (c: Category) => [c.id, ...children(c.id).map((s) => s.id)]
  const catsOf = (a: Album) => a.category_ids ?? (a.category_id ? [a.category_id] : [])
  const inAny = (a: Album, ids: string[]) => catsOf(a).some((id) => ids.includes(id))
  const countIn = (c: Category) => albumList.filter((a) => inAny(a, idsOf(c))).length
  const uncategorized = albumList.filter((a) => catsOf(a).length === 0)

  const current = selected ? all.find((c) => c.id === selected) ?? null : null
  const currentSubs = current ? children(current.id) : []
  const inCurrent = current
    ? albumList.filter((a) => inAny(a, idsOf(current)))
    : uncategorized
  const norm = fold(query.trim())
  // Порядок альбомов — свой у каждой категории (макет 14). Правим порядок
  // того, что открыто: подкатегории из фильтра или самой категории. Альбомы,
  // лежащие только в подкатегориях, идут следом — как на витрине.
  const orderIn = chip || current?.id || null
  const place = (a: Album): [number, number] => {
    if (!orderIn) return [0, 0]
    const own = localPos?.[a.id] ?? a.category_pos?.[orderIn]
    if (own !== undefined) return [0, own]
    const sub = catsOf(a).find((id) => current && idsOf(current).includes(id))
    return [1, (sub && a.category_pos?.[sub]) || 0]
  }
  const visible = inCurrent
    .filter((a) => !chip || catsOf(a).includes(chip))
    .filter((a) => !norm || fold(a.title).includes(norm))
    .sort((x, y) => place(x)[0] - place(y)[0] || place(x)[1] - place(y)[1])
  // Карточку бросили на другую карточку: альбом встаёт перед ней.
  const dropOnAlbum = (targetId: string, what = drag) => {
    setDrag(null)
    setDropAlbum(null)
    if (!orderIn || !what || what.kind !== 'album' || what.id === targetId) return
    const direct = inCurrent
      .filter((a) => catsOf(a).includes(orderIn))
      .sort((x, y) => place(x)[1] - place(y)[1])
      .map((a) => a.id)
    // Переставлять можно только то, что лежит прямо в открытой категории.
    if (!direct.includes(what.id) || !direct.includes(targetId)) return
    const ids = direct.filter((id) => id !== what.id)
    ids.splice(ids.indexOf(targetId), 0, what.id)
    setLocalPos(Object.fromEntries(ids.map((id, i) => [id, i + 1])))
    reorderAlbums.mutate({ categoryId: orderIn, ids })
  }
  const catTitle = (id: string | null) => (id ? all.find((c) => c.id === id)?.title : undefined)
  // Подпись карточки — подкатегории открытой категории, где лежит альбом
  // (макет 14: «Пуховики, Куртки и парки»); у подкатегории и «Без категории» — нет.
  const subTitles = (a: Album) =>
    currentSubs
      .filter((s) => catsOf(a).includes(s.id))
      .map((s) => s.title)
      .join(', ')
  // Карандаш и «+ Подкатегория» на странице категории (телефон) — поле в
  // списке: закрываем страницу, иначе поле появится в скрытом дереве.
  const editInTree = (start: () => void) => {
    setPaneOpen(false)
    start()
  }

  return (
    <div>
      <div className="page__head">
        <h1>Категории</h1>
        <span className="spacer" />
        <button className="btn btn--primary btn--pill" onClick={() => setAdding({ parentId: null })}>
          <Icon as={Plus} size={18} />
          Новая категория
        </button>
      </div>
      <p className="page__lead">
        Группируйте альбомы — покупатели увидят категории на витрине
      </p>

      {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}

      <div className={`cats ${paneOpen ? 'cats--pane' : ''}`}>
        <div
          ref={treeRef}
          className={treeOrdering ? 'cattree cattree--ordering' : 'cattree'}
          // Телефон (макет 14 · Mobile): нажатие на категорию открывает её
          // отдельным экраном, назад — «‹ Категории».
          onClick={(e) => {
            const row = (e.target as HTMLElement).closest('.cattree__row')
            if (row && !(e.target as HTMLElement).closest('.cattree__handle')) setPaneOpen(true)
          }}
        >
          {treeOrdering ? (
            // Режим «Изменить порядок» (макет 14 · Tablet/Mobile): подсказка и
            // «Готово» вместо сводки, «⋯» и «Добавить категорию» скрыты.
            <div className="cattree__sum cattree__sum--order">
              Перетащите за ручку
              <button className="cats__done" onClick={() => setTreeOrdering(false)}>
                <Icon as={Check} size={14} />
                Готово
              </button>
            </div>
          ) : (
          <div className="cattree__sum">
            {roots.length === 0 ? (
              'Категорий пока нет'
            ) : (
              <>
                {roots.length} {plural(roots.length, 'категория', 'категории', 'категорий')} ·{' '}
                {all.length - roots.length}{' '}
                {plural(all.length - roots.length, 'подкатегория', 'подкатегории', 'подкатегорий')}
              </>
            )}
          </div>
          )}
          {roots.map((c) => {
            const subs = children(c.id)
            const open = subs.length > 0 && isOpen(c.id)
            return (
            <div key={c.id}>
              {renaming === c.id ? (
                <TreeInput
                  initial={c.title}
                  onCancel={() => setRenaming(null)}
                  onSave={(title) => {
                    rename.mutate({ id: c.id, title, slug: c.slug, parentId: c.parent_id })
                    setRenaming(null)
                  }}
                />
              ) : (
              <div className={`cattree__item ${selected === c.id ? 'cattree__item--on' : ''}`}>
              <button
                data-cat-id={c.id}
                className="cattree__row"
                data-drop={dropMark(c)}
                data-dragging={(drag?.kind === 'category' && drag.id === c.id) || undefined}
                aria-current={selected === c.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', c.title)
                  setDrag({ kind: 'category', id: c.id })
                }}
                onDragEnd={() => {
                  setDrag(null)
                  setDropOn(null)
                }}
                {...dropProps(c)}
                onClick={() => {
                  setSelected(c.id)
                  setChip('')
                  setPicked(new Set())
                  setQuery('')
                }}
                // Подкатегории с клавиатуры — стрелками, как в дереве: → раскрыть,
                // ← свернуть (шеврон внутри кнопки фокус получить не может).
                aria-expanded={subs.length > 0 ? open : undefined}
                onKeyDown={(e) => {
                  if (subs.length === 0) return
                  if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
                    e.preventDefault()
                    toggleOpen(c.id)
                  }
                }}
              >
                <span className="cattree__handle" aria-hidden="true" {...treeReorder.handle(c.id, dropCategoryById)}>
                  <Icon as={GripVertical} />
                </span>
                {subs.length > 0 ? (
                  <span
                    className="cattree__chev"
                    aria-hidden="true"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleOpen(c.id)
                    }}
                  >
                    <Icon as={open ? ChevronDown : ChevronRight} />
                  </span>
                ) : (
                  <span className="cattree__chev" aria-hidden="true" />
                )}
                {/* «не на главной» — у счётчика, на планшете — под названием (макет 14). */}
                <span className="cattree__name">
                  <b className={c.is_hidden ? 'cattree__title text-ink-3' : 'cattree__title'}>{c.title}</b>
                  {!c.is_hidden && !c.on_home && (
                    <span className="cattree__badge">
                      <HomeIcon size={13} />
                      не на главной
                    </span>
                  )}
                </span>
                {c.is_hidden && (
                  <span className="cattree__eye" role="img" aria-label="Скрыта с витрины">
                    <Icon as={EyeOffIcon} size={15} />
                  </span>
                )}
                <span className="cnt">{countIn(c)}</span>
              </button>
              {/* На телефоне «⋯» у каждой строки (макет 14 · Mobile), на
                  компьютере — только у выбранной: прячет CSS. */}
              {!treeOrdering && (
                <CategoryActions
                  category={c}
                  subCount={subs.length}
                  onStartRename={() => setRenaming(c.id)}
                  onAddSub={() => setAdding({ parentId: c.id })}
                  onDelete={() => void removeCategory(c)}
                  onVisibility={(patch) => visibility.mutate({ category: c, patch })}
                />
              )}
              </div>
              )}
              {(open || adding?.parentId === c.id) && subs.map((sub) =>
                renaming === sub.id ? (
                  <TreeInput
                    key={sub.id}
                    sub
                    initial={sub.title}
                    onCancel={() => setRenaming(null)}
                    onSave={(title) => {
                      rename.mutate({ id: sub.id, title, slug: sub.slug, parentId: sub.parent_id })
                      setRenaming(null)
                    }}
                  />
                ) : (
                <div key={sub.id} className={`cattree__item ${selected === sub.id ? 'cattree__item--on' : ''}`}>
                <button
                  data-cat-id={sub.id}
                  className="cattree__row cattree__row--sub"
                  data-drop={dropMark(sub)}
                  data-dragging={(drag?.kind === 'category' && drag.id === sub.id) || undefined}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', sub.title)
                    setDrag({ kind: 'category', id: sub.id })
                  }}
                  onDragEnd={() => {
                    setDrag(null)
                    setDropOn(null)
                  }}
                  aria-current={selected === sub.id}
                  {...dropProps(sub)}
                  onClick={() => {
                    setSelected(sub.id)
                    setChip('')
                    setPicked(new Set())
                    setQuery('')
                  }}
                >
                  <span className="cattree__handle" aria-hidden="true" {...treeReorder.handle(sub.id, dropCategoryById)}>
                    <Icon as={GripVertical} />
                  </span>
                  <span className={`cattree__title ${sub.is_hidden || c.is_hidden ? 'text-ink-3' : ''}`}>{sub.title}</span>
                  {sub.is_hidden && (
                    <span className="cattree__eye" role="img" aria-label="Скрыта с витрины">
                      <Icon as={EyeOffIcon} size={15} />
                    </span>
                  )}
                  <span className="spacer" />
                  <span className="cnt">{countIn(sub)}</span>
                </button>
                {!treeOrdering && (
                  <CategoryActions
                    category={sub}
                    subCount={0}
                    onStartRename={() => setRenaming(sub.id)}
                    onDelete={() => void removeCategory(sub)}
                    onVisibility={(patch) => visibility.mutate({ category: sub, patch })}
                  />
                )}
                </div>
                ),
              )}
              {/* Новая подкатегория — поле под последней подкатегорией. */}
              {adding?.parentId === c.id && (
                <TreeInput
                  sub
                  initial=""
                  busy={create.isPending}
                  onCancel={() => setAdding(null)}
                  onSave={(title) => create.mutate({ title, parentId: c.id })}
                />
              )}
            </div>
            )
          })}
          {/* Новая категория — строка с полем в конце списка. */}
          {adding && adding.parentId === null && (
            <TreeInput
              initial=""
              busy={create.isPending}
              onCancel={() => setAdding(null)}
              onSave={(title) => create.mutate({ title, parentId: null })}
            />
          )}
          <div className="cattree__none">
            <button
              className="cattree__row"
              aria-current={selected === null && !noneYet}
              onClick={() => {
                setSelected(null)
                setChip('')
                setPicked(new Set())
                setQuery('')
              }}
            >
              <span className="cattree__chev">
                <Icon as={Inbox} />
              </span>
              <span className="cattree__title">Без категории</span>
              <span className="spacer" />
              <span className="cattree__only">
                <Icon as={EyeOffIcon} size={13} />
                только вам
              </span>
              <span className="cnt">{uncategorized.length}</span>
            </button>
          </div>
          {!treeOrdering && (
            <button className="cattree__add" onClick={() => setAdding({ parentId: null })}>
              <Icon as={Plus} />
              Добавить категорию
            </button>
          )}
          {roots.length > 1 && !treeOrdering && (
            <button className="cattree__add touch-only" onClick={() => setTreeOrdering(true)}>
              <Icon as={GripVertical} />
              Изменить порядок
            </button>
          )}
        </div>

        {noneYet ? (
          <div className="catpane catpane--empty">
            <div className="emptybox">
              <div className="emptybox__ico emptybox__ico--brand" aria-hidden="true">
                <Icon as={FolderTree} size={28} />
              </div>
              <h2>Создайте первую категорию</h2>
              <p>Категории появятся на витрине отдельной вкладкой с выпадающим списком — покупателям будет проще найти нужное</p>
              <button className="btn btn--primary btn--pill" onClick={() => setAdding({ parentId: null })}>
                <Icon as={Plus} size={18} />
                Новая категория
              </button>
            </div>
          </div>
        ) : (
        <div className="catpane">
          <button className="catpane__back" onClick={() => setPaneOpen(false)}>
            <Icon as={ChevronLeft} />
            Категории
          </button>
          <div className="catpane__head">
            <div className="catpane__title">
            <h2>
              {current ? current.title : 'Без категории'}
              {current && (
                // На телефоне дерево скрыто страницей категории — поле
                // переименования открывается в списке (макет 14 · Mobile).
                <button className="catpane__rename" onClick={() => editInTree(() => setRenaming(current.id))} aria-label="Переименовать" title="Переименовать">
                  <Icon as={Pen} size={18} />
                </button>
              )}
              {(!current || current.is_hidden) && (
                <span className="catpane__badge">
                  <Icon as={EyeOffIcon} size={14} />
                  {current ? 'Скрыта с витрины' : 'Видно только вам'}
                </span>
              )}
            </h2>
            <p className="catpane__meta">
              {currentSubs.length > 0 &&
                `${currentSubs.length} ${plural(currentSubs.length, 'подкатегория', 'подкатегории', 'подкатегорий')} · `}
              {inCurrent.length > 0
                ? `${inCurrent.length} ${plural(inCurrent.length, 'альбом', 'альбома', 'альбомов')}`
                : 'Нет альбомов'}
            </p>
            </div>
            <span className="spacer" />
            {current && (
              <div className="catpane__acts">
                {current.is_hidden ? (
                  <button
                    className="btn btn--ghost btn--pill"
                    onClick={() => visibility.mutate({ category: current, patch: { is_hidden: false } })}
                  >
                    <Icon as={Eye} size={18} />
                    Показать на витрине
                  </button>
                ) : (
                  !current.parent_id && (
                    <button className="btn btn--ghost btn--pill" onClick={() => editInTree(() => setAdding({ parentId: current.id }))}>
                      <Icon as={Plus} size={18} />
                      Подкатегория
                    </button>
                  )
                )}
                <button className="btn btn--primary btn--pill" onClick={() => setPicking(true)}>
                  <Icon as={FolderPlus} size={18} />
                  Добавить альбомы
                </button>
              </div>
            )}
          </div>


          {(!current || current.is_hidden) && (
            <p className="catpane__note">
              <Icon as={Info} size={16} />
              {current
                ? 'Покупатели не видят эту категорию на витрине. Сами альбомы остаются доступны — по ссылке и в других категориях.'
                : 'Здесь альбомы, которые не лежат ни в одной категории. Покупатели этот раздел не видят. Чтобы альбом попал на витрину в категорию — добавьте его туда.'}
            </p>
          )}

          {currentSubs.length > 0 && (
            <div className="chips">
              <button aria-pressed={chip === ''} onClick={() => setChip('')}>
                Все <span className="cnt">{inCurrent.length}</span>
              </button>
              {currentSubs.map((s) => (
                <button key={s.id} aria-pressed={chip === s.id} onClick={() => setChip(s.id)}>
                  {s.title} <span className="cnt">{countIn(s)}</span>
                </button>
              ))}
            </div>
          )}

          {inCurrent.length > 0 && (
          <div className="alhead">
            {/* Макет 14: «Выбрать все» слева, поиск справа. В режиме порядка
                «Выбрать все» приглушено, поиск скрыт, «Готово» — справа. */}
            {visible.length > 0 && (current || all.length > 0) && (
              <SelectAll
                picked={picked.size}
                all={visible.every((a) => picked.has(a.id))}
                disabled={albumOrdering}
                onToggle={() =>
                  setPicked(visible.every((a) => picked.has(a.id)) ? new Set() : new Set(visible.map((a) => a.id)))
                }
              />
            )}
            {current && picked.size > 0 && (
              <>
                <button
                  className="alhead__act alhead__act--danger"
                  onClick={() =>
                    setRemoving({ list: inCurrent.filter((a) => picked.has(a.id)), from: current.title, ids: idsOf(current) })
                  }
                >
                  <Icon as={Trash2} size={16} />
                  Убрать из категории
                </button>
              </>
            )}
            {!current && picked.size > 0 && (
              <>
                <button
                  className="alhead__act"
                  onClick={() => setPlacing(uncategorized.filter((a) => picked.has(a.id)))}
                  disabled={all.length === 0}
                >
                  <Icon as={Plus} size={16} />
                  Добавить в категории
                </button>
              </>
            )}
            {current && visible.length > 1 && picked.size === 0 && !albumOrdering && (
              <button className="alhead__order" onClick={() => setAlbumOrdering(true)}>
                <Icon as={GripVertical} size={14} />
                Изменить порядок
              </button>
            )}
            <span className="spacer" />
            {albumOrdering && (
              <button className="cats__done" onClick={() => setAlbumOrdering(false)}>
                <Icon as={Check} size={14} />
                Готово
              </button>
            )}
            <span className="catpane__search" hidden={albumOrdering}>
              <Icon as={Search} />
              {/* «Найти альбом» на планшете и телефоне — подпись короче (макет 14). */}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={narrow ? 'Найти альбом' : 'Поиск в категории'}
                aria-label="Поиск в категории"
              />
              {query && (
                <button className="catpane__clear" onClick={() => setQuery('')} aria-label="Очистить поиск">
                  <Icon as={X} size={14} />
                </button>
              )}
            </span>
            {albumOrdering && (
              <p className="cats__hint">
                <Icon as={Info} size={14} />
                Перетащите альбом за ручку, чтобы поменять порядок
              </p>
            )}
          </div>
          )}

          {visible.length === 0 ? (
            norm ? (
              <div className="emptybox">
                <h3>Ничего не найдено</h3>
                <p>
                  В «{current ? current.title : 'Без категории'}» нет альбомов по запросу «{query.trim()}»
                </p>
                <button className="emptybox__link" onClick={() => setQuery('')}>
                  Сбросить поиск
                </button>
              </div>
            ) : current ? (
              <div className="emptybox">
                <div className="emptybox__ico emptybox__ico--brand" aria-hidden="true">
                  <Icon as={ImageIcon} size={24} />
                </div>
                <h3>В категории пока нет альбомов</h3>
                <p>
                  Категория уже видна покупателям на витрине. Добавьте в неё альбомы или создайте подкатегории
                </p>
                <button className="btn btn--primary btn--pill" onClick={() => setPicking(true)}>
                  <Icon as={FolderPlus} size={18} />
                  Добавить альбомы
                </button>
              </div>
            ) : (
              <p className="text-sm text-ink-2">Все альбомы разложены по категориям.</p>
            )
          ) : (
            <>
            <div className="algrid" ref={gridRef}>
              {visible.map((a) => (
                <div
                  key={a.id}
                  className="alcard"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy'
                    e.dataTransfer.setData('text/plain', a.title)
                    setDrag({ kind: 'album', id: a.id })
                  }}
                  onDragEnd={() => {
                    setDrag(null)
                    setDropOn(null)
                    setDropAlbum(null)
                  }}
                  onDragOver={(e) => {
                    if (!orderIn || drag?.kind !== 'album' || drag.id === a.id) return
                    e.preventDefault()
                    setDropAlbum(a.id)
                  }}
                  onDragLeave={() => setDropAlbum((cur) => (cur === a.id ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault()
                    dropOnAlbum(a.id)
                  }}
                  data-dropbefore={dropAlbum === a.id || albumReorder.over === a.id || undefined}
                  data-album-id={a.id}
                >
                  {albumOrdering && current ? (
                    <span className="photo__handle" aria-label="Перетащить альбом" {...albumReorder.handle(a.id, (from, to) => dropOnAlbum(to, { kind: 'album', id: from }))}>
            <Icon as={GripVertical} size={14} />
          </span>
                  ) : (current || all.length > 0) && (
                    <input
                      type="checkbox"
                      className="alcard__pick"
                      checked={picked.has(a.id)}
                      onChange={() => {
                        const next = new Set(picked)
                        if (next.has(a.id)) next.delete(a.id)
                        else next.add(a.id)
                        setPicked(next)
                      }}
                      aria-label={`Выбрать «${a.title}»`}
                    />
                  )}
                  <Link to="/albums/$albumId" params={{ albumId: a.id }} className="alcard__cover" aria-label={a.title}>
                    {a.cover_urls ? (
                      <img src={a.cover_urls.small} alt="" loading="lazy" />
                    ) : (
                      <span className="alcard__cover--empty" aria-hidden="true">
                        <Icon as={ImageIcon} size={32} />
                      </span>
                    )}
                    <span className="alcard__count">{a.photo_count} фото</span>
                  </Link>
                  {/* Большой круглый крестик по центру обложки (макет 14).
                      Альбом убирается только из открытой категории — или из
                      подкатегории, если она выбрана в фильтре. */}
                  {current && !albumOrdering && (
                    <button
                      className="alcard__x"
                      onClick={() =>
                        setRemoving(
                          chip
                            ? { list: [a], from: catTitle(chip) ?? current.title, ids: [chip] }
                            : { list: [a], from: current.title, ids: idsOf(current) },
                        )
                      }
                      title="Убрать из категории"
                      aria-label={`Убрать «${a.title}» из категории`}
                    >
                      <Icon as={X} size={26} />
                    </button>
                  )}
                  <div className="alcard__body">
                    <b title={a.title}>{a.title}</b>
                    {subTitles(a) && (
                      <span className="alcard__cat" title={subTitles(a)}>
                        {subTitles(a)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            </>
          )}
        </div>
        )}
      </div>

      {/* Макет 14 · «Убрать альбом — подтверждение»: сначала вопрос, потом
          уведомление с «Отменить». */}
      {removing && (
        <Portal><div className="modal__back" role="alertdialog" aria-modal="true" aria-label="Убрать из категории">
          <div className="modal modal--sm">
            <span className="confirm__ico" aria-hidden="true">
              <Icon as={Trash2} size={22} />
            </span>
            <div className="modal__head">
              <h2>
                {removing.list.length === 1
                  ? 'Убрать альбом из категории?'
                  : `Убрать ${removing.list.length} ${plural(removing.list.length, 'альбом', 'альбома', 'альбомов')} из категории?`}
              </h2>
            </div>
            <p className="modal__text">
              {removing.list.length === 1 ? 'Альбом будет убран' : 'Альбомы будут убраны'} из «{removing.from}».{' '}
              {removing.list.length === 1
                ? 'Сам альбом не удалится и останется в других категориях. Если он больше нигде не лежит — попадёт в «Без категории».'
                : 'Сами альбомы не удалятся и останутся в других категориях. Те, что больше нигде не лежат, попадут в «Без категории».'}
            </p>
            <div className="modal__foot">
              <span className="spacer" />
              <button className="btn btn--ghost" onClick={() => setRemoving(null)} autoFocus>
                Отмена
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  void unassign(removing.list, removing.from, removing.ids)
                  setRemoving(null)
                }}
              >
                Убрать
              </button>
            </div>
          </div>
        </div></Portal>
      )}

      {/* На телефоне тост снизу (макет 14 · Mobile) — как в «Альбомах». */}
      {toast && (
        <div className="al__toast"><Toast
          text={toast.text}
          actions={
            toast.undo
              ? [
                  {
                    label: toast.undoLabel ?? 'Отменить',
                    run: () => {
                      toast.undo?.()
                      setToast(null)
                    },
                  },
                ]
              : []
          }
          onClose={() => setToast(null)}
        /></div>
      )}

      {picking && current && (
        <PickAlbumsDialog
          // Список фильтруется в самом окне — по выбранным местам.
          albums={albumList}
          inPlaces={catsOf}
          initialPlace={chip || current.id}
          categories={all}
          catTitle={catTitle}
          onCancel={() => setPicking(false)}
          onPick={(ids, placeIds) => {
            for (const id of ids) for (const categoryId of placeIds) assign.mutate({ albumId: id, categoryId })
            setPicking(false)
          }}
        />
      )}

      {/* Макет 14 · «Без категории — добавить в категории»: разложить
          выбранные альбомы сразу по нескольким категориям. */}
      {placing && (
        <PlacesDialog
          albums={placing}
          categories={all}
          onCancel={() => setPlacing(null)}
          onPick={(categoryIds) => {
            const list = placing
            setPlacing(null)
            void Promise.allSettled(
              list.flatMap((a) => categoryIds.map((categoryId) => api.addAlbumToCategory(shop.id, categoryId, a.id))),
            ).then((results) => {
              refresh()
              setPicked(new Set())
              const failed = results.filter((r) => r.status === 'rejected').length
              setToast({
                text: failed
                  ? 'Не все альбомы добавлены. Проверьте интернет и попробуйте ещё раз'
                  : `${list.length} ${plural(list.length, 'альбом добавлен', 'альбома добавлены', 'альбомов добавлено')} в ${categoryIds.length} ${plural(categoryIds.length, 'категорию', 'категории', 'категорий')}`,
              })
            })
          }}
        />
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

// Меню «⋯» строки дерева (макет 14): переименовать, подкатегория, «На
// главной», скрыть, удалить. Удаление — после подтверждения; альбомы
// остаются, а вернуть категорию можно из тоста.
function CategoryActions({
  category,
  subCount,
  onStartRename,
  onAddSub,
  onDelete,
  onVisibility,
}: {
  category: Category
  subCount: number
  onStartRename: () => void
  onAddSub?: () => void
  onDelete: () => void
  onVisibility: (patch: { is_hidden?: boolean; on_home?: boolean }) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    // Меню «⋯» у выбранной строки дерева (макет 14 · Меню «⋯»).
    <span className="cattree__more" onClick={(e) => e.stopPropagation()}>
      <Popover
        open={open}
        onToggle={setOpen}
        label="Действия"
        title={`Действия с «${category.title}»`}
        sheet
        sheetTitle={category.title}
        plain
        icon={<Icon as={Ellipsis} size={18} />}
      >
        <div className="popmenu" role="menu" onClick={() => setOpen(false)}>
          <button role="menuitem" onClick={onStartRename}>
            <Icon as={Pen} />
            Переименовать
          </button>
          {onAddSub && (
            <button role="menuitem" onClick={onAddSub}>
              <Icon as={Plus} />
              Добавить подкатегорию
            </button>
          )}
          {/* «На главной» — только у категорий верхнего уровня: блоками на
              главной витрины стоят они, подкатегории живут внутри. */}
          {!category.parent_id && (
            <button
              role="menuitemcheckbox"
              aria-checked={category.on_home}
              onClick={() => onVisibility({ on_home: !category.on_home })}
            >
              <HomeIcon size={16} viewBox="-1.85 -1.85 16 16" />
              На главной
              <span className={`mswitch ${category.on_home ? 'mswitch--on' : ''}`} aria-hidden="true" />
            </button>
          )}
          <button role="menuitem" onClick={() => onVisibility({ is_hidden: !category.is_hidden })}>
            <Icon as={category.is_hidden ? Eye : EyeOffIcon} />
            {category.is_hidden ? 'Показать на витрине' : 'Скрыть с витрины'}
          </button>
          <hr className="popmenu__sep" />
          <button role="menuitem" className="popmenu__danger" onClick={() => setConfirming(true)}>
            <Icon as={Trash2} />
            Удалить
          </button>
        </div>
      </Popover>
      {/* Подтверждение — окном, как в макете 14 · «Удаление — подтверждение».
          Подкатегории уносятся вместе с родителем (каскад по внешнему
          ключу) — продавец должен видеть, что теряет и структуру. */}
      {confirming && (
        <Portal><div className="modal__back" role="alertdialog" aria-modal="true" aria-label="Удаление категории">
          <div className="modal modal--sm">
            <span className="confirm__ico" aria-hidden="true">
              <Icon as={Trash2} size={22} />
            </span>
            <div className="modal__head">
              <h2>Удалить категорию «{category.title}»?</h2>
            </div>
            <p className="modal__text">
              {subCount > 0 &&
                `Вместе с ней ${plural(subCount, 'удалится', 'удалятся', 'удалятся')} ${subCount} ${plural(subCount, 'подкатегория', 'подкатегории', 'подкатегорий')}. `}
              Альбомы останутся — те, что больше ни в одной категории, попадут в «Без категории».
            </p>
            <div className="modal__foot">
              <span className="spacer" />
              <button className="btn btn--ghost" onClick={() => setConfirming(false)} autoFocus>
                Отмена
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  setConfirming(false)
                  onDelete()
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        </div></Portal>
      )}
    </span>
  )
}


// Поле в строке дерева: новая категория, подкатегория или переименование
// (макет 14). Enter или галочка — сохранить, Esc или крестик — отменить.
// Единственная ошибка названия — пустое поле.
function TreeInput({
  initial,
  sub = false,
  busy = false,
  onSave,
  onCancel,
}: {
  initial: string
  sub?: boolean
  busy?: boolean
  onSave: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [empty, setEmpty] = useState(false)
  // Двойной Enter не создаёт вторую категорию: второй запрос уходил с тем
  // же адресом и возвращался ошибкой «адрес занят».
  const flight = useSingleFlight()
  const save = () => {
    const title = value.trim()
    if (!title) {
      setEmpty(true)
      return
    }
    if (!flight.enter()) return
    setTimeout(flight.leave, 1000)
    // Название не меняли — сохранять нечего.
    if (title === initial) onCancel()
    else onSave(title)
  }
  return (
    <div className={`cattree__edit ${sub ? 'cattree__edit--sub' : ''}`}>
      <div className="cattree__editrow">
        <input
          autoFocus
          // Текст сразу выделен: чаще название заменяют целиком.
          onFocus={(e) => e.target.select()}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setEmpty(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') onCancel()
          }}
          maxLength={40}
          placeholder={sub ? 'Название подкатегории' : 'Название категории'}
          aria-label={sub ? 'Название подкатегории' : 'Название категории'}
          aria-invalid={empty}
          disabled={busy}
          className="inp"
        />
        {/* Счётчик длины, как в макете 14 · «Новая категория». */}
        <span className="cattree__len" aria-hidden="true">
          {value.length}/40
        </span>
        <button className="cattree__ok" onClick={save} disabled={busy} aria-label="Сохранить" title="Сохранить">
          <Icon as={Check} size={18} strokeWidth={2.2} />
        </button>
        <button className="cattree__no" onClick={onCancel} disabled={busy} aria-label="Отменить" title="Отменить">
          <Icon as={X} size={18} strokeWidth={2.2} />
        </button>
      </div>
      {empty && <p className="cattree__err">Введите название</p>}
    </div>
  )
}

// Метка места: подкатегория — вместе с родителем (макет 14 · чипсы
// «Верхняя одежда: Куртки и парки»).
function placeLabel(categories: Category[], id: string): string {
  const c = categories.find((x) => x.id === id)
  if (!c) return ''
  const parent = c.parent_id ? categories.find((x) => x.id === c.parent_id) : undefined
  return parent ? `${parent.title}: ${c.title}` : c.title
}

function PlaceChips({
  categories,
  value,
  onRemove,
}: {
  categories: Category[]
  value: Set<string>
  onRemove: (id: string) => void
}) {
  return (
    <>
      {[...value].map((id) => (
        <span key={id} className="placechip">
          {placeLabel(categories, id)}
          <button
            type="button"
            className="placechip__x"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(id)
            }}
            aria-label={`Убрать «${placeLabel(categories, id)}»`}
          >
            <Icon as={X} size={12} />
          </button>
        </span>
      ))}
    </>
  )
}

// Дерево категорий с поиском и флажками — выбор мест (макет 14 ·
// «Добавить альбомы — выбор мест», «Без категории — добавить в категории»).
function PlaceTree({
  categories,
  value,
  onToggle,
  autoFocus,
}: {
  categories: Category[]
  value: Set<string>
  onToggle: (id: string) => void
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const roots = categories.filter((c) => !c.parent_id)
  const subs = (id: string) => categories.filter((c) => c.parent_id === id)
  // Раскрыты те, где уже отмечена подкатегория.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(categories.filter((c) => c.parent_id && value.has(c.id)).map((c) => c.parent_id as string)),
  )
  const norm = fold(query.trim())
  const match = (c: Category) => !norm || fold(c.title).includes(norm)
  return (
    <div className="placetree">
      <label className="placetree__search">
        <Icon as={Search} size={16} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти категорию или подкатегорию"
          aria-label="Найти категорию или подкатегорию"
          autoFocus={autoFocus}
        />
      </label>
      <ul className="placetree__list">
        {roots.length === 0 && <li className="placetree__empty">Категорий пока нет</li>}
        {roots.map((root) => {
          const children = subs(root.id)
          const shownSubs = children.filter(match)
          if (!match(root) && shownSubs.length === 0) return null
          // При поиске подходящие подкатегории видны сразу.
          const expanded = children.length > 0 && (open.has(root.id) || (norm !== '' && shownSubs.length > 0))
          return (
            <li key={root.id}>
              <div className={value.has(root.id) ? 'placetree__row is-on' : 'placetree__row'}>
                {children.length > 0 ? (
                  <button
                    type="button"
                    className="placetree__chev"
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Свернуть' : 'Развернуть'}
                    onClick={() => {
                      const next = new Set(open)
                      if (next.has(root.id)) next.delete(root.id)
                      else next.add(root.id)
                      setOpen(next)
                    }}
                  >
                    <Icon as={expanded ? ChevronDown : ChevronRight} size={14} />
                  </button>
                ) : (
                  <span className="placetree__chev" aria-hidden="true" />
                )}
                <label>
                  <input type="checkbox" checked={value.has(root.id)} onChange={() => onToggle(root.id)} />
                  <b>{root.title}</b>
                </label>
              </div>
              {expanded &&
                shownSubs.map((sub) => (
                  <div key={sub.id} className={value.has(sub.id) ? 'placetree__row placetree__row--sub is-on' : 'placetree__row placetree__row--sub'}>
                    <label>
                      <input type="checkbox" checked={value.has(sub.id)} onChange={() => onToggle(sub.id)} />
                      {sub.title}
                    </label>
                  </div>
                ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function PickAlbumsDialog({
  albums,
  inPlaces,
  initialPlace,
  categories,
  catTitle,
  onCancel,
  onPick,
}: {
  albums: Album[]
  // Где альбом уже лежит — id его категорий.
  inPlaces: (a: Album) => string[]
  initialPlace: string
  categories: Category[]
  catTitle: (id: string | null) => string | undefined
  onCancel: () => void
  onPick: (ids: string[], placeIds: string[]) => void
}) {
  // По умолчанию — открытая категория или подкатегория из фильтра (макет 14).
  const [where, setWhere] = useState<Set<string>>(new Set([initialPlace]))
  const [placesOpen, setPlacesOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const norm = fold(query.trim())
  // В списке только альбомы, которых ещё нет хотя бы в одном из выбранных
  // мест (макет 14): остальным добавлять некуда.
  const shown = albums
    .filter((a) => where.size === 0 || [...where].some((id) => !inPlaces(a).includes(id)))
    .filter((a) => !norm || fold(a.title).includes(norm))
  const n = picked.size
  const backdrop = useDialogClose(onCancel)

  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label="Добавить альбомы" {...backdrop}>
      <div className="modal modal--pick">
        <div className="modal__head">
          <div>
            <h2>Добавить альбомы</h2>
            <p>Один альбом может лежать в нескольких категориях</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={onCancel} aria-label="Закрыть">
            <Icon as={X} size={20} />
          </button>
        </div>
        <div className="modal__text pick">
          <span className="pick__label">Куда добавить — можно выбрать несколько мест</span>
          <div className="pick__places">
            {/* Поле — не кнопка: внутри него кнопки «убрать» у чипсов, а кнопка
                в кнопке недоступна с клавиатуры и путает чтение с экрана.
                Мышью открывается щелчком по полю, клавиатурой — кнопкой-стрелкой. */}
            <div
              className={placesOpen ? 'pick__field is-open' : 'pick__field'}
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('.placechip')) setPlacesOpen(!placesOpen)
              }}
            >
              <span className="pick__chips">
                {where.size === 0 && <span className="pick__ph">Выберите категории</span>}
                <PlaceChips categories={categories} value={where} onRemove={(id) => setWhere(toggled(where, id))} />
              </span>
              <button
                type="button"
                className="pick__toggle"
                aria-expanded={placesOpen}
                aria-label="Куда добавить"
                onClick={(e) => {
                  e.stopPropagation()
                  setPlacesOpen(!placesOpen)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && placesOpen) {
                    e.preventDefault()
                    e.stopPropagation()
                    setPlacesOpen(false)
                  }
                }}
              >
                <Icon as={placesOpen ? ChevronUp : ChevronDown} size={16} />
              </button>
            </div>
            {placesOpen && (
              <>
                <div className="pick__shade" onClick={() => setPlacesOpen(false)} aria-hidden="true" />
                <div
                  className="pick__drop"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setPlacesOpen(false)
                    }
                  }}
                >
                  <PlaceTree categories={categories} value={where} onToggle={(id) => setWhere(toggled(where, id))} autoFocus />
                </div>
              </>
            )}
          </div>
          <label className="placetree__search mt-4">
            <Icon as={Search} size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по названию альбома"
              aria-label="Поиск по названию альбома"
            />
          </label>
          <ul className="pick__list">
            {shown.map((a) => {
              const cats = inPlaces(a)
                .map((id) => catTitle(id))
                .filter(Boolean)
                .join(', ')
              return (
                <li key={a.id}>
                  <label className={picked.has(a.id) ? 'pickrow is-on' : 'pickrow'}>
                    <input type="checkbox" checked={picked.has(a.id)} onChange={() => setPicked(toggled(picked, a.id))} />
                    <span className="pickrow__img">
                      {a.cover_urls ? <img src={a.cover_urls.small} alt="" loading="lazy" /> : <Icon as={ImageIcon} size={16} />}
                    </span>
                    <span className="pickrow__main">
                      <b>{a.title}</b>
                      <span>
                        {cats ? `${cats} · ` : 'Без категории · '}
                        {a.photo_count} фото
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
            {shown.length === 0 && (
              <li className="pick__empty">
                {norm ? 'Ничего не найдено.' : 'Все альбомы уже лежат в выбранных местах.'}
              </li>
            )}
          </ul>
        </div>
        <div className="modal__foot">
          <p className="hint">Выбрано: {n}</p>
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={onCancel}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            disabled={n === 0 || where.size === 0}
            onClick={() => onPick([...picked], [...where])}
          >
            {n === 0 ? 'Добавить' : `Добавить ${n} ${plural(n, 'альбом', 'альбома', 'альбомов')}`}
          </button>
        </div>
      </div>
    </div></Portal>
  )
}

// Выбор категорий для альбомов из «Без категории» (макет 14 · «Без
// категории — добавить в категории»).
function PlacesDialog({
  albums,
  categories,
  onCancel,
  onPick,
}: {
  albums: Album[]
  categories: Category[]
  onCancel: () => void
  onPick: (categoryIds: string[]) => void
}) {
  const [where, setWhere] = useState<Set<string>>(new Set())
  const count = albums.length
  const backdrop = useDialogClose(onCancel)
  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label="Добавить в категории" {...backdrop}>
      <div className="modal modal--pick">
        <div className="modal__head">
          <div>
            <h2>
              {count === 1
                ? 'Добавить альбом в категории'
                : `Добавить ${count} ${plural(count, 'альбом', 'альбома', 'альбомов')} в категории`}
            </h2>
            <p className="truncate">{albums.map((a) => a.title).join(', ')}</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={onCancel} aria-label="Закрыть">
            <Icon as={X} size={20} />
          </button>
        </div>
        <div className="modal__text pick">
          {where.size > 0 && (
            <div className="pick__chips mb-4">
              <PlaceChips categories={categories} value={where} onRemove={(id) => setWhere(toggled(where, id))} />
            </div>
          )}
          <PlaceTree categories={categories} value={where} onToggle={(id) => setWhere(toggled(where, id))} />
        </div>
        <div className="modal__foot">
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={onCancel}>
            Отмена
          </button>
          <button className="btn btn--primary" disabled={where.size === 0} onClick={() => onPick([...where])}>
            Добавить
          </button>
        </div>
      </div>
    </div></Portal>
  )
}
