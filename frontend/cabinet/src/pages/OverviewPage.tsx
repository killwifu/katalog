import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../api'
import { PLAN_NAMES } from '../lib/plans'
import { useShop } from './AppLayout'

// Обзор кабинета по макету 09 · Desktop · v2: четыре строки, разделённые
// линиями, в каждой — левый блок на 540px и правый на остатке ширины.
//
// «Поделиться» стоит в первой строке рядом со счётчиками: продавец
// отправляет ссылку по десять раз в день, это главное действие в кабинете.
export function OverviewPage() {
  const shop = useShop()
  // Берём 14 дней и делим пополам: так дельта к прошлой неделе считается
  // из одного ответа, без второго запроса и без правок бэкенда.
  const stats = useQuery({
    queryKey: ['stats', shop.id, 14],
    queryFn: () => api.getStats(shop.id, 14),
  })
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const billing = useQuery({ queryKey: ['billing', shop.id], queryFn: () => api.getBilling(shop.id) })
  const downgrade = useQuery({ queryKey: ['downgrade', shop.id], queryFn: () => api.getDowngrade(shop.id) })
  // Корзина в блоке хранилища: удалённое продолжает занимать место, и без
  // этой строки продавец у лимита не понимает, куда оно делось.
  const trash = useQuery({ queryKey: ['trash', shop.id, 1], queryFn: () => api.listTrash(shop.id) })
  const [copied, setCopied] = useState<'no' | 'yes' | 'fail'>('no')
  // Макет предлагает считать расход и в фотографиях, и в гигабайтах:
  // лимит тарифа упирается то в одно, то в другое.
  const [unit, setUnit] = useState<'photos' | 'gb'>('photos')

  const shopUrl = `${location.origin}/${shop.slug}`
  // Буфер обмена отказывает в небезопасном контексте и при отказе в
  // разрешении. Без catch это был необработанный reject, а надпись
  // «Скопировано» появлялась в любом случае — продавец отправлял
  // покупателю пустоту.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shopUrl)
      setCopied('yes')
    } catch {
      setCopied('fail')
      return
    }
    setTimeout(() => setCopied('no'), 2000)
  }

  const daily = stats.data?.daily ?? []
  const week = daily.slice(-7)
  const prevWeek = daily.slice(-14, -7)
  const sum = (rows: typeof daily, key: 'views' | 'unique_visitors' | 'lead_clicks') =>
    rows.reduce((n, d) => n + d[key], 0)

  const photos = billing.data?.usage.photos
  const gbUsed = shop.storage_used / 1024 / 1024 / 1024
  const gbMax = shop.storage_max / 1024 / 1024 / 1024
  const num = (n: number) => n.toLocaleString('ru-RU')

  return (
    <div className="ov">
      {/* Предложение выбрать видимое висит в кабинете, пока фотографий больше
          лимита: если продавец не выберет, мы всё равно ничего не удаляем. */}
      {downgrade.data?.over_limit && (
        <div className="alert alert--warn">
          <span className="flex-1">
            Фотографий больше, чем помещается в тариф: {downgrade.data.total_photos} из{' '}
            {downgrade.data.max_photos}. Выберите, что останется видимым покупателям.
          </span>
          <Link to="/downgrade" className="shrink-0 font-medium underline">
            Выбрать
          </Link>
        </div>
      )}

      <div className="ov__row">
        <section>
          <div className="ov__head">
            <h2>Сведения об альбомах</h2>
          </div>
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
            <div className="counts">
              <p>
                <span>Альбомов: </span>
                <b>{albums.data ? num(albums.data.length) : '…'}</b>
              </p>
              <p>
                <span>Фото: </span>
                <b>{photos === undefined ? '…' : num(photos)}</b>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/albums" className="btn btn--primary btn--sm">
                Новый альбом
              </Link>
              <button onClick={() => void copy()} className="btn btn--ghost btn--sm">
                {copied === 'yes' ? 'Скопировано' : 'Поделиться'}
              </button>
            </div>
          </div>
          {copied === 'fail' && (
            <p className="hint text-danger">
              Не удалось скопировать —{' '}
              <a href={shopUrl} target="_blank" rel="noopener noreferrer" className="underline">
                откройте витрину
              </a>{' '}
              и возьмите адрес из строки браузера.
            </p>
          )}
        </section>

        <section>
          <div className="ov__head">
            <h2>Тариф «{PLAN_NAMES[shop.plan]}»</h2>
          </div>
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
            <p className="text-sm text-ink-3">
              {shop.paid_until ? (
                <>
                  Действует до{' '}
                  <b className="text-[18px] font-medium text-brand">
                    {new Date(shop.paid_until).toLocaleDateString('ru-RU')}
                  </b>
                </>
              ) : (
                'Бессрочный'
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Link to="/billing" className="btn btn--ghost btn--sm">
                Продлить
              </Link>
              <Link to="/billing" className="btn btn--ghost btn--sm">
                Улучшить
              </Link>
            </div>
          </div>
        </section>
      </div>

      <div className="ov__sep" />

      <div className="ov__row">
        <section>
          <div className="ov__head">
            <h2>Использование хранилища</h2>
            <div className="seg">
              <button aria-pressed={unit === 'photos'} onClick={() => setUnit('photos')}>
                Фото
              </button>
              <button aria-pressed={unit === 'gb'} onClick={() => setUnit('gb')}>
                ГБ
              </button>
            </div>
          </div>
          {unit === 'photos' ? (
            <p>
              <b className="bignum">{photos === undefined ? '…' : num(photos)}</b>
              <span>/ из {num(shop.max_photos)} фото</span>
            </p>
          ) : (
            <p>
              <b className="bignum">{gbUsed.toFixed(1).replace('.', ',')}</b>
              <span>/ из {gbMax.toFixed(0)} ГБ</span>
            </p>
          )}
          {(trash.data?.total ?? 0) > 0 && (
            <p className="mt-2 text-sm text-ink-3">
              В Удаленном: {num(trash.data!.total)} фото{' '}
              <Link to="/trash" className="font-medium text-brand">
                Открыть
              </Link>
            </p>
          )}
        </section>

        <section>
          <div className="ov__head">
            <h2>За последние 7 дней</h2>
            <Link to="/stats">Вся статистика</Link>
          </div>
          {/* Молчаливые нули при отказе статистики продавец читает как
              «витрину никто не смотрит» и идёт разбираться не туда. */}
          {stats.isError ? (
            <p className="text-sm text-danger">Не удалось загрузить статистику.</p>
          ) : (
            <p>
              <b className="bignum">{num(sum(week, 'views'))}</b>
              <span>просмотров витрины</span>
            </p>
          )}
          <div className={`mt-2 flex flex-wrap gap-x-5 gap-y-1 py-2 text-sm ${stats.isError ? 'hidden' : ''}`}>
            <p className={delta(sum(week, 'views'), sum(prevWeek, 'views')).up ? 'text-[#1B6B3A]' : 'text-ink-3'}>
              <b className="font-semibold">{delta(sum(week, 'views'), sum(prevWeek, 'views')).label}</b>
              <span className="text-ink-3"> к прошлой неделе</span>
            </p>
            <p>
              <b className="font-semibold">{num(sum(week, 'lead_clicks'))}</b>
              <span className="text-ink-2"> переходов в мессенджер</span>
            </p>
            <p>
              <b className="font-semibold">{num(sum(week, 'unique_visitors'))}</b>
              <span className="text-ink-2"> уникальных посетителей</span>
            </p>
          </div>
        </section>
      </div>

      {(stats.data?.top_albums.length ?? 0) > 0 && (
        <>
          <div className="ov__sep" />
          <section>
            <div className="ov__head">
              <h2>Что смотрят чаще всего</h2>
              <span className="text-sm text-ink-3">за 7 дней</span>
            </div>
            <div className="ovcards">
              {stats.data!.top_albums.slice(0, 4).map((a) => (
                <Link key={a.album_id} to="/albums/$albumId" params={{ albumId: a.album_id }} className="ovcard">
                  <i aria-hidden="true" />
                  <span className="min-w-0">
                    <b>{a.title}</b>
                    <span>{num(a.views)} просмотров</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// Дельта к прошлой неделе отвечает на вопрос «стало лучше или хуже» —
// само по себе число просмотров на него не отвечает.
function delta(value: number, prev: number): { label: string; up: boolean } {
  if (prev === 0) return { label: value > 0 ? 'новые' : 'пока пусто', up: value > 0 }
  const pct = Math.round(((value - prev) / prev) * 100)
  if (pct === 0) return { label: 'столько же', up: false }
  return { label: `${pct > 0 ? '+' : ''}${pct}%`, up: pct > 0 }
}
