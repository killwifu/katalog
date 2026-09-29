import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, type Album, type Category } from '../api'
import { useShop } from './AppLayout'
import { NewAlbumDialog } from './NewAlbumDialog'

// Альбомы по макету 10 · Desktop · v2: сетка обложек вместо списка строк.
// Продавец узнаёт альбом по фотографии, а не по названию — из-за этого
// в карточке остались только обложка, название, категория и статус.
const PER_PAGE = [36, 60, 120] as const

export function AlbumsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const categories = useQuery({
    queryKey: ['categories', shop.id],
    queryFn: () => api.listCategories(shop.id),
  })
  const albums = useQuery({
    queryKey: ['albums', shop.id],
    queryFn: () => api.listAlbums(shop.id),
  })
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [sort, setSort] = useState<'recent' | 'title' | 'photos'>('recent')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [perPage, setPerPage] = useState<number>(PER_PAGE[0])
  const [page, setPage] = useState(1)

  // Удаление уносит и фотографии альбома: их место и место в квоте
  // возвращает сервер, поэтому обновляем и счётчики в меню.
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAlbum(shop.id, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
      void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
    },
  })

  if (albums.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (albums.isError) return <p className="text-danger">Не удалось загрузить альбомы.</p>

  // Фильтрация на клиенте: список альбомов одного продавца ограничен
  // тарифом и целиком уже загружен — гонять за этим сервер незачем.
  const norm = query.trim().toLowerCase()
  const catName = new Map((categories.data ?? []).map((c: Category) => [c.id, c.title]))
  const found = albums.data
    .filter((a) => !a.parent_id)
    .filter((a) => !norm || a.title.toLowerCase().includes(norm))
    .filter((a) => !categoryId || a.category_id === categoryId)
    .sort((x, y) => {
      if (sort === 'title') return x.title.localeCompare(y.title, 'ru')
      if (sort === 'photos') return y.photo_count - x.photo_count
      return 0
    })

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

  return (
    <div>
      <div className="albar">
        <button onClick={() => setCreating(true)} className="btn btn--primary">
          Создать альбом
        </button>
        {/* Кнопки «Загрузить фото» здесь нет намеренно: в макете она открывает
            массовую загрузку с раскладкой по альбомам, а её пока нет. Фото
            грузятся в конкретный альбом — с его страницы или при создании. */}
        <input
          className="inp albar__search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
          placeholder="Поиск по названию"
          aria-label="Поиск по названию"
        />
        <select
          className="inp albar__sel"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label="Сортировка"
        >
          <option value="recent">Сначала новые</option>
          <option value="title">По названию</option>
          <option value="photos">По числу фото</option>
        </select>
        <select
          className="inp albar__sel"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value)
            setPage(1)
          }}
          aria-label="Категория"
        >
          <option value="">Все категории</option>
          {(categories.data ?? []).map((c: Category) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>

      {creating && (
        <NewAlbumDialog
          shopId={shop.id}
          categories={categories.data ?? []}
          onClose={() => setCreating(false)}
        />
      )}

      <div className="alhead">
        <label>
          <input type="checkbox" checked={allPicked} onChange={toggleAll} disabled={shown.length === 0} />
          Выбрать все
        </label>
        {picked.size > 0 && <span>Выбрано: {picked.size}</span>}
        <span className="spacer" />
        <span>{found.length} альбома</span>
      </div>

      {found.length === 0 && (norm || categoryId) && (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">🔍</div>
          <h3>Ничего не найдено</h3>
          <p>Попробуйте другое название или снимите фильтр по категории.</p>
        </div>
      )}

      {found.length === 0 && !norm && !categoryId && (
        <div className="emptybox">
          <div className="emptybox__ico" aria-hidden="true">📷</div>
          <h3>Альбомов пока нет</h3>
          <p>
            Альбом — это набор фотографий с подписями: цена, размер, артикул.
            Создайте первый и загрузите снимки — витрина соберётся сама.
          </p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="algrid">
          {shown.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              category={album.category_id ? catName.get(album.category_id) : undefined}
              picked={picked.has(album.id)}
              onPick={() => toggleOne(album.id)}
              onDelete={remove.mutate}
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
            ‹
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
            ›
          </button>
        </div>
      )}

      {remove.isError && <p className="mt-3 text-sm text-danger">Не удалось удалить альбом.</p>}
    </div>
  )
}

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
  onDelete,
}: {
  album: Album
  category?: string
  picked: boolean
  onPick: () => void
  onDelete: (id: string) => void
}) {
  const status = album.blocked_by_moderator
    ? { label: 'Скрыт модератором', cls: 'badge badge--warn' }
    : STATUS[album.status] ?? STATUS.draft
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="alcard">
      <input
        type="checkbox"
        className="alcard__pick"
        checked={picked}
        onChange={onPick}
        aria-label={`Выбрать «${album.title}»`}
      />
      <Link
        to="/albums/$albumId"
        params={{ albumId: album.id }}
        className="alcard__edit"
        aria-label={`Открыть «${album.title}»`}
      >
        ✎
      </Link>
      <Link to="/albums/$albumId" params={{ albumId: album.id }} className="alcard__cover">
        {album.cover_urls ? (
          <img src={album.cover_urls.small} alt="" loading="lazy" />
        ) : (
          <span className="alcard__cover--empty" aria-hidden="true">
            ▦
          </span>
        )}
        <span className="alcard__count">{album.photo_count} фото</span>
      </Link>
      <div className="alcard__body">
        <b title={album.title}>{album.title}</b>
        <span className="alcard__cat">{category ?? 'Без категории'}</span>
        {confirming ? (
          <div className="alcard__foot">
            <button onClick={() => setConfirming(false)} className="btn btn--ghost btn--sm">
              Отмена
            </button>
            <button onClick={() => onDelete(album.id)} className="btn btn--danger btn--sm">
              Удалить
            </button>
          </div>
        ) : (
          <div className="alcard__foot">
            <span className={status.cls}>{status.label}</span>
            <span className="spacer" />
            <button
              onClick={() => setConfirming(true)}
              className="text-xs text-ink-2 hover:text-danger"
              aria-label={`Удалить «${album.title}»`}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
