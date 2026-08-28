import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorText, type DowngradeAlbum } from '../api'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { useShop } from './AppLayout'

type Strategy = 'viewed' | 'recent' | 'manual'

// Набираем альбомы, пока помещаются в лимит. Альбом либо входит целиком,
// либо не входит: выбор идёт по альбомам, а счёт — в фотографиях (kit).
function pick(albums: DowngradeAlbum[], limit: number): string[] {
  const out: string[] = []
  let used = 0
  for (const a of albums) {
    if (used + a.photo_count > limit) continue
    out.push(a.id)
    used += a.photo_count
  }
  return out
}

export function DowngradePage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const state = useQuery({ queryKey: ['downgrade', shop.id], queryFn: () => api.getDowngrade(shop.id) })

  const [strategy, setStrategy] = useState<Strategy>('viewed')
  const [manual, setManual] = useState<string[] | null>(null)

  const save = useMutation({
    mutationFn: (ids: string[]) => api.applyDowngrade(shop.id, ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['downgrade', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['albums', shop.id] })
    },
  })

  if (state.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (state.isError) return <p className="text-danger">Не удалось загрузить данные тарифа.</p>

  const { albums, max_photos, total_photos, over_limit } = state.data
  // Приходят уже отсортированными по просмотрам; для «самых свежих»
  // достаточно перевернуть по дате создания — она в порядке добавления.
  const byViews = albums
  const byRecent = [...albums].reverse()

  const selected =
    strategy === 'manual'
      ? (manual ?? albums.filter((a) => !a.hidden_by_plan).map((a) => a.id))
      : pick(strategy === 'viewed' ? byViews : byRecent, max_photos)

  const selectedPhotos = albums
    .filter((a) => selected.includes(a.id))
    .reduce((n, a) => n + a.photo_count, 0)

  // Ручной выбор — это несколько минут работы при большом числе альбомов,
  // терять его при случайном переходе нельзя.
  useUnsavedGuard(manual !== null)

  const toggle = (id: string) =>
    setManual((prev) => {
      const base = prev ?? selected
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    })

  return (
    <div>
      <div className="page__head">
        <h1>Что оставить видимым</h1>
      </div>

      {over_limit ? (
        <div className="alert alert--warn">
          На тарифе «{state.data.plan}» видимыми останутся {max_photos} фотографий
          из {total_photos} — остальные скроются, но сохранятся в кабинете.
        </div>
      ) : (
        <>
          <div className="alert alert--info">
            Все фотографии помещаются в тариф — выбирать ничего не нужно.
          </div>
          <p className="page__lead">
            Экран пригодится, если фотографий станет больше лимита: тогда здесь
            можно будет отметить, что покупатели продолжат видеть.
          </p>
        </>
      )}

      {!over_limit ? null : (
      <>
      <p className="page__lead">
        Ничего не удаляем — выбираете только то, что покупатели продолжат видеть.
        Остальное вернётся, как только продлите подписку.
      </p>

      <label className="choice">
        <input type="radio" checked={strategy === 'viewed'} onChange={() => setStrategy('viewed')} />
        <span>
          <b>Самые просматриваемые</b>
          <p>Оставим альбомы, которые покупатели открывают чаще всего.</p>
        </span>
      </label>

      <label className="choice">
        <input type="radio" checked={strategy === 'recent'} onChange={() => setStrategy('recent')} />
        <span>
          <b>Самые свежие</b>
          <p>Оставим последние загруженные альбомы.</p>
        </span>
      </label>

      <label className="choice">
        <input type="radio" checked={strategy === 'manual'} onChange={() => setStrategy('manual')} />
        <span>
          <b>Выбрать вручную</b>
          <p>Отметите альбомы сами. Займёт несколько минут, если альбомов много.</p>
        </span>
      </label>

      {strategy === 'manual' && (
        <div className="rows my-4">
          {albums.map((a) => (
            <label key={a.id} className="rows__row cursor-pointer">
              <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
              <span className="rows__main">
                <b>{a.title}</b>
                <span className="rows__meta">
                  {a.photo_count} фото · {a.views} просмотров за 30 дней
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="box">
        <p className="text-sm text-ink-2">
          Останется видимыми: <b className="text-ink">{selectedPhotos}</b> из {total_photos} фотографий
          {selectedPhotos > max_photos && (
            <span className="text-danger"> — это больше лимита {max_photos}</span>
          )}
        </p>
        <div className="prog mt-2">
          <span style={{ width: `${Math.min(100, (selectedPhotos / Math.max(1, max_photos)) * 100)}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn--primary btn--block-mobile"
          onClick={() => save.mutate(selected)}
          disabled={save.isPending || selectedPhotos > max_photos}
        >
          {save.isPending ? 'Сохраняю…' : 'Сохранить выбор'}
        </button>
        <Link to="/billing" className="btn btn--ghost btn--block-mobile">
          Или продлить подписку
        </Link>
      </div>
      {save.isSuccess && <p className="hint">Выбор сохранён. Изменить можно в любой момент.</p>}
      {save.isError && <p className="hint text-danger">{errorText(save.error)}</p>}
      </>
      )}

      <div className="box mt-6">
        <h2>Что останется без изменений</h2>
        <p className="text-sm text-ink-2">
          Все альбомы, категории и разделы сохранятся в кабинете — их не придётся собирать заново.
          Скрытые фотографии хранятся 3 месяца; за месяц до удаления пришлём письмо со ссылкой на архив.
        </p>
      </div>
    </div>
  )
}
