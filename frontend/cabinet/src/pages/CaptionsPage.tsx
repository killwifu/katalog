import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, type Photo } from '../api'
import { useShop } from './AppLayout'

// Экран пакетного проставления подписей: последовательный проход по фото,
// одно текстовое поле, Enter = сохранить и перейти к следующему.
export function CaptionsPage() {
  const shop = useShop()
  const { albumId } = useParams({ from: '/app/albums/$albumId/captions' })

  // Страницами: альбом на старшем тарифе вмещает до 5000 фото, а выдача
  // отдаёт по сотне. Одной страницей проход по подписям молча обрывался
  // на сотом фото, и продавец считал, что подписал весь альбом.
  const photosQuery = useInfiniteQuery({
    queryKey: ['captions-photos', shop.id, albumId],
    queryFn: ({ pageParam }) => api.listPhotos(shop.id, albumId, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.per_page < last.total ? last.page + 1 : undefined,
    staleTime: Infinity,
  })

  const photos = (photosQuery.data?.pages ?? [])
    .flatMap((p) => p.photos)
    .filter((p) => p.status === 'ready')

  // Следующая страница подтягивается, когда продавец подходит к концу
  // загруженной: ждать её на последнем фото — заметная пауза.
  const loadMore = () => {
    if (photosQuery.hasNextPage && !photosQuery.isFetchingNextPage) {
      void photosQuery.fetchNextPage()
    }
  }

  if (photosQuery.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (photosQuery.isError) return <p className="text-danger">Не удалось загрузить фото.</p>
  if (photos.length === 0) {
    return (
      <div className="text-center text-ink-2">
        <p>Нет готовых фото для подписей.</p>
        <BackLink albumId={albumId} />
      </div>
    )
  }
  return (
    <CaptionWalker
      photos={photos}
      albumId={albumId}
      hasMore={photosQuery.hasNextPage}
      onNearEnd={loadMore}
    />
  )
}

const PREFETCH_MARGIN = 20

function CaptionWalker({
  photos,
  albumId,
  hasMore,
  onNearEnd,
}: {
  photos: Photo[]
  albumId: string
  hasMore: boolean
  onNearEnd: () => void
}) {
  const [index, setIndex] = useState(0)
  const [caption, setCaption] = useState(photos[0].caption)
  // Подписи, сохранённые за этот проход. Список фото лежит в кеше с
  // staleTime: Infinity и о сохранении не знает — без этой карты возврат
  // к предыдущему снимку показывал бы подпись, которую продавец уже стёр.
  const [saved] = useState(() => new Map<string, string>())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const photo = index < photos.length ? photos[index] : null

  // Поле всегда показывает подпись того фото, что на экране. Раньше её
  // подставлял advance(), но на стыке страниц следующего фото ещё не
  // существует: продавец подписывал сотое, видел «Загружаем следующие
  // фото…», а когда страница приезжала — сто первое открывалось с
  // подписью сотого. Enter, и чужая цена уехала на витрину.
  const [shownID, setShownID] = useState(photos[0].id)
  if (photo && photo.id !== shownID) {
    setShownID(photo.id)
    setCaption(saved.get(photo.id) ?? photo.caption)
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [index])

  if (!photo && hasMore) {
    return <p className="text-center text-ink-2">Загружаем следующие фото…</p>
  }
  if (!photo) {
    return (
      <div className="text-center">
        <p className="mb-2 text-lg font-medium text-ink">Готово!</p>
        {/* Пропущенные фото подписаны не были: считать их — врать продавцу,
            который потом ищет на витрине цены, которых нет. */}
        <p className="mb-4 text-ink-2">
          Сохранено подписей: {saved.size} из {photos.length}.
        </p>
        <BackLink albumId={albumId} />
      </div>
    )
  }

  const advance = (nextIndex: number) => {
    // Клампим: индекс ниже нуля дал бы photos[-1] === undefined и падение
    // на photo.id — проверка ниже ловит только выход за верхнюю границу.
    setIndex(Math.max(0, nextIndex))
    if (nextIndex >= photos.length - PREFETCH_MARGIN) onNearEnd()
    setError('')
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await api.updateCaption(photo.id, caption)
      saved.set(photo.id, caption)
      advance(index + 1)
    } catch {
      setError('Не удалось сохранить, попробуйте ещё раз')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-3 flex items-center justify-between text-sm text-ink-2">
        <BackLink albumId={albumId} />
        <span>
          {index + 1} / {photos.length}
          {hasMore && '+'}
        </span>
      </div>

      <div className="mb-4 overflow-hidden rounded-lg border border-line bg-white">
        <img
          src={photo.urls?.medium ?? photo.urls?.thumb}
          alt=""
          className="mx-auto max-h-96 w-full object-contain"
        />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <input
          ref={inputRef}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Название / цена / артикул — Enter для следующего"
          className="inp mb-2"
        />
        {error && <p className="mb-2 text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          {/* Возврат к предыдущему снимку: проход шёл только вперёд, и
              опечатка в цене становилась неисправимой внутри потока. */}
          <button
            type="button"
            onClick={() => advance(index - 1)}
            disabled={index === 0}
            aria-label="Предыдущее фото"
            title="Предыдущее фото"
            className="btn btn--ghost"
          >
            ←
          </button>
          <button
            type="submit"
            disabled={saving}
            className="btn btn--primary flex-1"
          >
            Сохранить и дальше
          </button>
          <button
            type="button"
            onClick={() => advance(index + 1)}
            className="btn btn--ghost"
          >
            Пропустить
          </button>
        </div>
      </form>
    </div>
  )
}

function BackLink({ albumId }: { albumId: string }) {
  return (
    <Link to="/albums/$albumId" params={{ albumId }} className="text-sm text-brand hover:underline">
      ← К альбому
    </Link>
  )
}
