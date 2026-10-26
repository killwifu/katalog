import { ArrowUpDown, Check, Filter, FolderPlus, Upload, Image as ImageIcon, Link as LinkIcon, Lock, Pen, Trash2, Search, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, type Album, type AlbumStatus, type Category } from '../api'
import { Icon } from '../lib/icons'
import { copyText } from '../lib/copyText'
import { takeFlash } from '../lib/flash'
import { plural } from '../lib/uploadRun'
import { AccessDialog } from './AccessDialog'
import { EditAlbumDialog } from './EditAlbumDialog'
import { useShop } from './AppLayout'
import { Toast } from './Toast'
import { NewAlbumDialog } from './NewAlbumDialog'
import { SelectAll } from './SelectAll'
import { Popover } from './Popover'
import { UploadDialog } from './UploadDialog'
import { fold } from '../lib/fold'
import { Portal } from '../lib/Portal'

// Альбомы по макету 10 · Desktop · v2: сетка обложек вместо списка строк.
// Продавец узнаёт альбом по фотографии, а не по названию — из-за этого
// в карточке остались только обложка, название, категория и статус.
const PER_PAGE = [36, 60, 120] as const

// Сортировка по макету «10 · Сортировка»: три признака, у каждого два
// направления.
const SORTS = [
  { id: 'new', group: 'Дата добавления', label: 'Сначала новые' },
  { id: 'old', group: 'Дата добавления', label: 'Сначала старые' },
  { id: 'az', group: 'Название', label: 'От А до Я' },
  { id: 'za', group: 'Название', label: 'От Я до А' },
  { id: 'more', group: 'Количество фото', label: 'Сначала больше' },
  { id: 'less', group: 'Количество фото', label: 'Сначала меньше' },
] as const
type SortId = (typeof SORTS)[number]['id']

const ACCESS_LABEL: Record<AlbumStatus, string> = {
  published: 'Опубликован',
  unlisted: 'По ссылке',
  draft: 'Черновик',
}
const ACCESS_ORDER: AlbumStatus[] = ['published', 'unlisted', 'draft']

// password: '' — не фильтровать, 'yes' — с паролем, 'no' — без пароля.
type Filter = { categoryId: string; access: AlbumStatus[]; password: '' | 'yes' | 'no' }
const NO_FILTER: Filter = { categoryId: '', access: [], password: '' }

// Уведомление поверх страницы; с action — ещё и кнопка («Повторить»).
type Toast = { text: string; action?: { label: string; run: () => void } }

const albumsWord = (n: number) => plural(n, 'альбом', 'альбома', 'альбомов')

function applyFilter(list: Album[], query: string, filter: Filter): Album[] {
  const norm = fold(query.trim())
  return list
    .filter((a) => !a.parent_id)
    .filter((a) => !norm || fold(a.title).includes(norm))
    .filter((a) => !filter.categoryId || (a.category_ids ?? []).includes(filter.categoryId))
    .filter((a) => filter.access.length === 0 || filter.access.includes(a.status))
    .filter((a) => !filter.password || a.has_password === (filter.password === 'yes'))
}

export function AlbumsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })
  const albums = useQuery({
    queryKey: ['albums', shop.id],
    queryFn: () => api.listAlbums(shop.id),
  })
  // Пришли с ярлыка «Загрузить фото» на обзоре — окно загрузки открыто сразу.
  const search = useSearch({ from: '/app/albums' })
  const [uploading, setUploading] = useState(() => Boolean(search.upload))
  // Кнопка «Создать альбом» в приветствии «Обзора» вела просто на список —
  // нажимать приходилось второй раз.
  const [creating, setCreating] = useState(() => Boolean(search.create))
  const [createFiles, setCreateFiles] = useState<File[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortId>('new')
  const [filter, setFilter] = useState<Filter>(NO_FILTER)
  const [menu, setMenu] = useState<'none' | 'sort' | 'filter'>('none')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [perPage, setPerPage] = useState<number>(PER_PAGE[0])
  const [page, setPage] = useState(1)
  // Что сейчас подтверждаем: удаление или смену доступа у этих альбомов.
  const [deleting, setDeleting] = useState<Album[] | null>(null)
  const [access, setAccess] = useState<Album[] | null>(null)
  const [editing, setEditing] = useState<Album | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  // Уведомление само уходит: это подтверждение сделанного, а не вопрос.
  // С кнопкой висит дольше — её ещё надо успеть нажать.
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), toast.action ? 10000 : 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
  }

  // Удаление обратимо: альбом с фотографиями уезжает в «Удаленное»,
  // поэтому вместе с уведомлением предлагается «Отменить».
  const restore = (list: Album[]) => {
    void Promise.allSettled(list.map((a) => api.restoreAlbum(shop.id, a.id))).then((back) => {
      refresh()
      const ok = back.filter((r) => r.status === 'fulfilled').length
      setToast({
        text:
          ok === list.length
            ? list.length === 1
              ? `Альбом «${list[0].title}» возвращён`
              : `${ok} ${albumsWord(ok)} ${plural(ok, 'возвращён', 'возвращены', 'возвращено')}`
            : `Вернулось ${ok} из ${list.length} — остальные в «Удаленном»`,
      })
    })
  }
  const remove = useMutation({
    mutationFn: async (list: Album[]) => {
      const results = await Promise.allSettled(list.map((a) => api.deleteAlbum(shop.id, a.id)))
      return list.filter((_, i) => results[i].status === 'rejected')
    },
    onSuccess: (left, list) => {
      refresh()
      const gone = list.filter((a) => !left.includes(a))
      setPicked((prev) => new Set([...prev].filter((id) => left.some((a) => a.id === id))))
      if (left.length === 0) {
        setToast({
          text:
            gone.length === 1
              ? `Альбом «${gone[0].title}» перемещён в «Удаленное»`
              : `${gone.length} ${albumsWord(gone.length)} ${plural(gone.length, 'перемещён', 'перемещены', 'перемещены')} в «Удаленное»`,
          action: { label: 'Отменить', run: () => restore(gone) },
        })
        return
      }
      // Часть не удалилась: повтор берёт только оставшиеся, иначе
      // «Повторить» упирался бы в уже удалённые и снова падал.
      setToast({
        text:
          gone.length > 0
            ? `Удалено ${gone.length} из ${list.length}. Проверьте интернет`
            : `Не удалось удалить ${plural(list.length, 'альбом', 'альбомы', 'альбомы')}. Проверьте интернет`,
        action: { label: 'Повторить', run: () => remove.mutate(left) },
      })
    },
  })

  // Уведомление со страницы альбома: его удалили там, а «Отменить» нужно здесь.
  useEffect(() => {
    const flash = takeFlash()
    if (!flash) return
    const id = flash.undoAlbumId
    queueMicrotask(() =>
      setToast({
        text: flash.text,
        action: id
          ? {
              label: 'Отменить',
              run: () =>
                void api.restoreAlbum(shop.id, id).then(
                  (a) => {
                    refresh()
                    setToast({ text: `Альбом «${a.title}» возвращён` })
                  },
                  () => setToast({ text: 'Не удалось вернуть альбом — он в «Удаленном»' }),
                ),
            }
          : undefined,
      }),
    )
    // Один раз при открытии страницы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (albums.isPending) {
    // Скелетон той же сетки: «Загрузка…» строкой заставляла страницу
    // прыгать, когда приходили карточки.
    return (
      <div aria-busy="true" aria-label="Загрузка альбомов">
        <div className="albar">
          <span className="skel skel--btn" />
          <span className="skel skel--btn" />
          <span className="skel skel--inp" />
        </div>
        <div className="algrid">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="alcard">
              <div className="alcard__cover skel" />
              <div className="alcard__body">
                <span className="skel skel--line" />
                <span className="skel skel--line skel--short" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (albums.isError) {
    return (
      <div className="emptybox">
        <h2>Не удалось загрузить альбомы</h2>
        <p>Проверьте интернет и попробуйте ещё раз.</p>
        <button className="btn btn--ghost" onClick={() => void albums.refetch()}>
          Повторить
        </button>
      </div>
    )
  }

  // Фильтрация на клиенте: список альбомов одного продавца ограничен
  // тарифом и целиком уже загружен — гонять за этим сервер незачем.
  const cats = categories.data ?? []
  const catName = new Map(cats.map((c: Category) => [c.id, c.title]))
  const top = albums.data.filter((a) => !a.parent_id)
  const created = (a: Album) => new Date(a.created_at).getTime()
  const found = applyFilter(albums.data, query, filter).sort((x, y) => {
    switch (sort) {
      case 'old':
        return created(x) - created(y)
      case 'az':
        return x.title.localeCompare(y.title, 'ru')
      case 'za':
        return y.title.localeCompare(x.title, 'ru')
      case 'more':
        return y.photo_count - x.photo_count
      case 'less':
        return x.photo_count - y.photo_count
      default:
        return created(y) - created(x)
    }
  })
  const filterCount = (filter.categoryId ? 1 : 0) + filter.access.length + (filter.password ? 1 : 0)
  const narrowed = query.trim() !== '' || filterCount > 0

  const pages = Math.max(1, Math.ceil(found.length / perPage))
  // Страница могла уехать за конец списка после фильтра или удаления.
  const current = Math.min(page, pages)
  const from = (current - 1) * perPage
  const shown = found.slice(from, from + perPage)

  const allPicked = shown.length > 0 && shown.every((a) => picked.has(a.id))
  const toggleAll = () => {
    const next = new Set(picked)
    for (const a of shown) {
      if (allPicked) next.delete(a.id)
      else next.add(a.id)
    }
    setPicked(next)
  }
  const toggleOne = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  // Выбранные считаем по живому списку: альбом могли удалить в другой вкладке.
  const pickedAlbums = top.filter((a) => picked.has(a.id))

  const copyLink = (album: Album) => {
    const url = `${location.origin}/${shop.slug}/a/${album.id}`
    void copyText(url).then((done) =>
      setToast({ text: done ? 'Ссылка на альбом скопирована' : 'Не удалось скопировать ссылку' }),
    )
  }

  const changeFilter = (next: Filter) => {
    setFilter(next)
    setPage(1)
  }

  return (
    <div>
      {/* На телефоне у страницы есть заголовок (макет 10 · Mobile). */}
      <h1 className="mtitle">Альбомы</h1>
      <div className="albar">
        <button onClick={() => setCreating(true)} className="btn btn--primary">
          <Icon as={FolderPlus} size={18} />
          Создать альбом
        </button>
        {/* «Загрузить фото» есть и без альбомов (макет 10 · «Нет альбомов»):
            массовая загрузка сама заводит альбомы из папок. Поиск,
            сортировка и фильтр без альбомов скрыты. */}
        <button onClick={() => setUploading(true)} className="btn btn--ghost">
          <Icon as={Upload} size={18} />
          Загрузить фото
        </button>
        {top.length > 0 && (
          <>
        {/* Планшет (макет 10 · Tablet): поиск, сортировка и фильтр — второй строкой. */}
        <span className="albar__break" aria-hidden="true" />
        <label className="albar__search">
          <Icon as={Search} size={16} />
          <input
            className="inp"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            placeholder="Поиск по названию"
            aria-label="Поиск по названию"
          />
        </label>
        <Popover
          open={menu === 'sort'}
          onToggle={(open) => setMenu(open ? 'sort' : 'none')}
          label={SORTS.find((s) => s.id === sort)?.label ?? ''}
          title="Сортировка"
          icon={<Icon as={ArrowUpDown} />}
          sheet
        >
          <div className="popmenu" role="menu">
            {SORTS.map((s, i) => (
              <div key={s.id}>
                {(i === 0 || SORTS[i - 1].group !== s.group) && <p className="popmenu__group">{s.group}</p>}
                <button
                  role="menuitemradio"
                  aria-checked={sort === s.id}
                  onClick={() => {
                    setSort(s.id)
                    setMenu('none')
                  }}
                >
                  {s.label}
                  {sort === s.id && <Icon as={Check} size={16} className="popmenu__check" />}
                </button>
              </div>
            ))}
          </div>
        </Popover>
        <Popover
          open={menu === 'filter'}
          onToggle={(open) => setMenu(open ? 'filter' : 'none')}
          label={filterCount > 0 ? `Фильтр · ${filterCount}` : 'Фильтр'}
          title="Фильтр"
          active={filterCount > 0}
          icon={<Icon as={Filter} />}
          chevron={false}
          sheet
        >
          <FilterPanel
            key={menu}
            value={filter}
            categories={cats}
            count={(draft) => applyFilter(albums.data, query, draft).length}
            onApply={(next) => {
              changeFilter(next)
              setMenu('none')
            }}
          />
        </Popover>
          </>
        )}
      </div>

      {filterCount > 0 && (
        <div className="chips chips--applied">
          {filter.access.map((s) => (
            <button
              key={s}
              onClick={() => changeFilter({ ...filter, access: filter.access.filter((x) => x !== s) })}
              aria-label={`Убрать фильтр «${ACCESS_LABEL[s]}»`}
            >
              Доступ: {ACCESS_LABEL[s]} <Icon as={X} size={14} />
            </button>
          ))}
          {filter.password && (
            <button onClick={() => changeFilter({ ...filter, password: '' })} aria-label="Убрать фильтр по паролю">
              Пароль: {filter.password === 'yes' ? 'с паролем' : 'без пароля'} <Icon as={X} size={14} />
            </button>
          )}
          {filter.categoryId && (
            <button onClick={() => changeFilter({ ...filter, categoryId: '' })} aria-label="Убрать фильтр по категории">
              Категория: {catName.get(filter.categoryId) ?? '—'} <Icon as={X} size={14} />
            </button>
          )}
          <button className="chips__reset" onClick={() => changeFilter(NO_FILTER)}>
            Сбросить все
          </button>
        </div>
      )}

      {creating && (
        <NewAlbumDialog
          shopId={shop.id}
          categories={cats}
          initialFiles={createFiles}
          onClose={(created) => {
            setCreating(false)
            setCreateFiles([])
            if (search.create) void navigate({ to: '/albums', search: {}, replace: true })
            if (!created) return
            // Макет 11 · «Альбом создан»: уведомление с переходом в альбом.
            setToast({
              text: `Альбом «${created.title}» создан`,
              action: {
                label: 'Открыть',
                run: () => void navigate({ to: '/albums/$albumId', params: { albumId: created.id } }),
              },
            })
            for (const delay of [3000, 10000]) {
              setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] }), delay)
            }
          }}
        />
      )}

      {uploading && (
        <UploadDialog
          shop={shop}
          albums={top}
          categories={cats}
          // Отмеченные в сетке альбомы — готовый ответ на «куда грузить».
          preselected={[...picked]}
          onCreateAlbum={(files) => {
            setUploading(false)
            setCreateFiles(files)
            setCreating(true)
          }}
          onClose={(done) => {
            setUploading(false)
            // Убираем ?upload из адреса, иначе обновление страницы снова откроет окно.
            if (search.upload) void navigate({ to: '/albums', search: {}, replace: true })
            if (!done) return
            setToast({ text: done })
            // Счётчик фото и обложку альбом получает, когда воркер закончит
            // обработку, а окно закрывается раньше. Без повторного запроса
            // карточка показывала старое число до перезагрузки страницы.
            for (const delay of [3000, 10000]) {
              setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] }), delay)
            }
          }}
        />
      )}

      {editing && (
        <EditAlbumDialog
          shopId={shop.id}
          album={editing}
          categories={cats}
          onClose={(saved) => {
            setEditing(null)
            if (!saved) return
            refresh()
            setToast({ text: 'Изменения сохранены' })
            for (const delay of [3000, 10000]) {
              setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] }), delay)
            }
          }}
        />
      )}

      {access && (
        <AccessDialog
          shopId={shop.id}
          plan={shop.plan}
          albums={access}
          onClose={(done) => {
            setAccess(null)
            if (!done) return
            refresh()
            setPicked(new Set())
            setToast({ text: done })
          }}
        />
      )}

      {deleting && (
        <Portal><div className="modal__back" role="alertdialog" aria-modal="true" aria-label="Удаление альбомов">
          <div className="modal modal--sm">
            <span className="confirm__ico" aria-hidden="true">
              <Icon as={Trash2} size={22} />
            </span>
            <div className="modal__head">
              <h2>
                {deleting.length === 1
                  ? `Удалить альбом «${deleting[0].title}»?`
                  : `Удалить ${deleting.length} ${albumsWord(deleting.length)}?`}
              </h2>
            </div>
            <p className="modal__text">
              {deleting.length === 1
                ? deleting[0].photo_count > 1
                  ? `Альбом и все ${deleting[0].photo_count.toLocaleString('ru-RU')} фото в нём переместятся`
                  : 'Альбом вместе с содержимым переместится'
                : 'Альбомы и все фото в них переместятся'}{' '}
              в «Удаленное». Там их можно восстановить, пока не истечёт срок хранения, потом они удалятся
              навсегда.
            </p>
            <div className="modal__foot">
              <span className="spacer" />
              <button className="btn btn--ghost" onClick={() => setDeleting(null)} autoFocus>
                Отмена
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  remove.mutate(deleting)
                  setDeleting(null)
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        </div></Portal>
      )}

      {toast && (
        <Toast
          text={toast.text}
          actions={
            toast.action
              ? [
                  {
                    label: toast.action.label,
                    run: () => {
                      toast.action?.run()
                      setToast(null)
                    },
                  },
                ]
              : []
          }
          onClose={() => setToast(null)}
        />
      )}

      {top.length > 0 && (
        <div className="alhead">
          <SelectAll picked={pickedAlbums.length} all={allPicked} onToggle={toggleAll} disabled={shown.length === 0} />
          {pickedAlbums.length > 0 && (
            <>
              <button className="alhead__act alhead__act--wide" onClick={() => setAccess(pickedAlbums)}>
                <Icon as={Lock} size={16} strokeWidth={2.25} />
                Изменить доступ
              </button>
              <button className="alhead__act alhead__act--wide" onClick={() => setDeleting(pickedAlbums)}>
                <Icon as={Trash2} size={16} />
                Удалить
              </button>
              <button className="alhead__act alhead__act--narrow" onClick={() => setPicked(new Set())}>
                Снять выбор
              </button>
              {/* Телефон: действия — закреплённой панелью внизу (макет 10 ·
                  «Выбрано 6 альбомов»). */}
              <div className="selbar">
                <button className="btn btn--primary" onClick={() => setAccess(pickedAlbums)}>
                  <Icon as={Lock} size={18} />
                  Доступ
                </button>
                <button className="btn btn--primary" onClick={() => setDeleting(pickedAlbums)}>
                  <Icon as={Trash2} size={18} />
                  Удалить
                </button>
              </div>
            </>
          )}
          <span className="spacer" />
          <span>
            {found.length} {albumsWord(found.length)}
          </span>
        </div>
      )}

      {found.length === 0 && narrowed && (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">
            <Icon as={filterCount > 0 ? Filter : Search} size={28} />
          </div>
          <h2>{filterCount > 0 ? 'Нет альбомов по выбранным фильтрам' : 'Ничего не найдено'}</h2>
          <p>
            {filterCount > 0
              ? 'Измените условия фильтра или сбросьте его, чтобы увидеть все альбомы.'
              : `По запросу «${query.trim()}» альбомов нет. Проверьте написание или попробуйте другое название.`}
          </p>
          <button
            className="btn btn--ghost btn--pill"
            onClick={() => {
              setQuery('')
              changeFilter(NO_FILTER)
            }}
          >
            {filterCount > 0 ? 'Сбросить фильтры' : 'Сбросить поиск'}
          </button>
        </div>
      )}

      {top.length === 0 && (
        <div className="emptybox">
          <div className="emptybox__ico emptybox__ico--brand" aria-hidden="true">
            <Icon as={FolderPlus} size={28} />
          </div>
          <h2>У вас пока нет альбомов</h2>
          <p>Создайте первый альбом и загрузите в него фото — покупатели увидят его на вашей витрине.</p>
          <button className="btn btn--primary btn--pill" onClick={() => setCreating(true)}>
            <Icon as={FolderPlus} size={18} />
            Создать альбом
          </button>
        </div>
      )}

      {shown.length > 0 && (
        <div className="algrid">
          {shown.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              free={shop.plan === 'free'}
              // Альбом может лежать в нескольких категориях — показываем все.
              category={
                (album.category_ids ?? [])
                  .map((id) => catName.get(id))
                  .filter(Boolean)
                  .join(', ') || undefined
              }
              picked={picked.has(album.id)}
              onPick={() => toggleOne(album.id)}
              onEdit={() => setEditing(album)}
              onAccess={() => setAccess([album])}
              onCopy={() => copyLink(album)}
            />
          ))}
        </div>
      )}

      {found.length > PER_PAGE[0] && (
        <div className="alpager">
          <span>
            {from + 1}–{from + shown.length} из {found.length}
          </span>
          <span className="spacer" />
          <select
            className="inp albar__sel"
            value={perPage}
            onChange={(e) => {
              setPerPage(Number(e.target.value))
              setPage(1)
            }}
            aria-label="Альбомов на странице"
          >
            {PER_PAGE.map((n) => (
              <option key={n} value={n}>
                {n} на странице
              </option>
            ))}
          </select>
          <button onClick={() => setPage(current - 1)} disabled={current === 1} aria-label="Назад">
            <Icon as={ChevronLeft} />
          </button>
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - current) <= 1)
            .map((n, i, list) => (
              <span key={n} className="flex items-center gap-2">
                {i > 0 && list[i - 1] !== n - 1 && <span>…</span>}
                <button onClick={() => setPage(n)} aria-current={n === current}>
                  {n}
                </button>
              </span>
            ))}
          <button onClick={() => setPage(current + 1)} disabled={current === pages} aria-label="Вперёд">
            <Icon as={ChevronRight} />
          </button>
        </div>
      )}
    </div>
  )
}

// Панель фильтра по макету «10 · Фильтр». Условия набираются в черновике и
// применяются кнопкой, на которой сразу видно, сколько альбомов останется.
function FilterPanel({
  value,
  categories,
  count,
  onApply,
}: {
  value: Filter
  categories: Category[]
  count: (draft: Filter) => number
  onApply: (next: Filter) => void
}) {
  const [draft, setDraft] = useState<Filter>(value)
  const n = count(draft)
  return (
    <div className="fpanel">
      <label className="field">
        <span>Категория</span>
        <select
          className="inp"
          value={draft.categoryId}
          onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
        >
          <option value="">Все категории</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="fpanel__set">
        <legend>Доступ</legend>
        {ACCESS_ORDER.map((s) => (
          <label key={s}>
            <input
              type="checkbox"
              checked={draft.access.includes(s)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  access: e.target.checked ? [...draft.access, s] : draft.access.filter((x) => x !== s),
                })
              }
            />
            {ACCESS_LABEL[s]}
          </label>
        ))}
      </fieldset>
      <fieldset className="fpanel__set">
        <legend>Пароль</legend>
        {(['yes', 'no'] as const).map((v) => (
          <label key={v}>
            <input
              type="checkbox"
              checked={draft.password === v}
              // Два взаимоисключающих флажка, как в макете: снятый — «неважно».
              onChange={(e) => setDraft({ ...draft, password: e.target.checked ? v : '' })}
            />
            {v === 'yes' ? 'С паролем' : 'Без пароля'}
          </label>
        ))}
      </fieldset>
      <div className="fpanel__foot">
        <button className="btn btn--quiet" onClick={() => setDraft(NO_FILTER)}>
          Сбросить
        </button>
        <button className="btn btn--primary" onClick={() => onApply(draft)}>
          Показать {n} {albumsWord(n)}
        </button>
      </div>
    </div>
  )
}

// Крестика «удалить» на карточке нет, как и в макете: удаление — через
// выбор альбомов и «Удалить» в строке над сеткой либо из меню «Ещё» на
// странице альбома.
// Статусы видны прямо на карточке: продавцу важно с одного взгляда понять,
// что покупатель уже видит, а что лежит черновиком.
const STATUS: Record<Album['status'], { label: string; cls: string }> = {
  published: { label: 'Опубликован', cls: 'badge badge--live' },
  unlisted: { label: 'По ссылке', cls: 'badge badge--link' },
  draft: { label: 'Черновик', cls: 'badge badge--draft' },
}

function AlbumCard({
  album,
  category,
  picked,
  onPick,
  onEdit,
  onAccess,
  onCopy,
  free,
}: {
  album: Album
  // Бесплатный тариф: паролей нет, подсказка на замке ведёт к оплате.
  free: boolean
  category?: string
  picked: boolean
  onPick: () => void
  onEdit: () => void
  onAccess: () => void
  onCopy: () => void
}) {
  const status = album.blocked_by_moderator
    ? { label: 'Скрыт модератором', cls: 'badge badge--warn' }
    : STATUS[album.status] ?? STATUS.draft

  return (
    <div className="alcard">
      <input
        type="checkbox"
        className="alcard__pick"
        checked={picked}
        onChange={onPick}
        aria-label={`Выбрать «${album.title}»`}
      />
      {/* Карандаш — полное окно редактирования с фотографиями; сама
          карточка ведёт на страницу альбома (макет 12). */}
      <button className="alcard__edit" onClick={onEdit} aria-label={`Редактировать «${album.title}»`} title="Редактировать">
        <Icon as={Pen} size={12} strokeWidth={3} />
      </button>
      <Link to="/albums/$albumId" params={{ albumId: album.id }} className="alcard__cover" aria-label={album.title}>
        {album.cover_urls ? (
          <img src={album.cover_urls.small} alt="" loading="lazy" />
        ) : (
          <span className="alcard__cover--empty" aria-hidden="true">
            <Icon as={ImageIcon} size={32} />
          </span>
        )}
        <span className="alcard__count">{album.photo_count} фото</span>
      </Link>
      <div className="alcard__body">
        <b title={album.title}>{album.title}</b>
        <span className="alcard__cat">{category ?? 'Без категории'}</span>
        <div className="alcard__foot">
          {/* Статус — кнопка: по макету доступ меняется прямо с карточки. */}
          {album.blocked_by_moderator ? (
            <span className={status.cls}>{status.label}</span>
          ) : (
            <button className="alcard__status" onClick={onAccess} title="Нажмите, чтобы изменить доступ">
              <span className={status.cls}>{status.label}</span>
            </button>
          )}
          <span className="spacer" />
          {/* Подсказки при наведении (макет 10): замок и скрепка. На Free
              паролей нет — в подсказке ссылка «Оплатить подписку». */}
          {!album.blocked_by_moderator && (
            <span className="tip">
            <button
              className={`alcard__ico ${album.has_password ? 'alcard__ico--on' : ''}`}
              onClick={onAccess}
              aria-label={`«${album.title}»: ${album.has_password ? 'защищён паролем' : 'без пароля'}. Изменить доступ`}
            >
              <Icon as={Lock} strokeWidth={2.4} />
            </button>
              <span className="tip__body" role="tooltip">
                {album.has_password && free ? (
                  // Пароль остался с платного тарифа (макет 10).
                  <>
                    <b>Защищён паролем</b>Пароль сохранён, но на вашем тарифе изменить его нельзя.{' '}
                    <Link to="/billing">Оплатить подписку</Link>
                  </>
                ) : album.has_password ? (
                  <>
                    <b>Защищён паролем</b>Нажмите, чтобы изменить доступ
                  </>
                ) : free ? (
                  <>
                    <b>Без пароля</b>На вашем тарифе опция недоступна ·{' '}
                    <Link to="/billing">Оплатить подписку</Link>
                  </>
                ) : (
                  <>
                    <b>Без пароля</b>Нажмите, чтобы задать пароль
                  </>
                )}
              </span>
            </span>
          )}
          {album.status !== 'draft' && !album.blocked_by_moderator && (
            <span className="tip">
            <button className="alcard__ico" onClick={onCopy} aria-label={`Скопировать ссылку на «${album.title}»`}>
              <Icon as={LinkIcon} strokeWidth={2.4} />
            </button>
              <span className="tip__body" role="tooltip">
                Скопировать ссылку на альбом
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
