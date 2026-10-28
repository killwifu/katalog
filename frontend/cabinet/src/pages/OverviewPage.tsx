import { useQuery } from '@tanstack/react-query'
import { fillDays } from '../lib/stats'
import { Droplet, MessageCircle, SlidersHorizontal, Trash2, Upload, RefreshCw, WifiOff } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { useSegThumb } from '../lib/useSegThumb'
import { api, type Billing, type Shop } from '../api'
import { ChartIcon, Icon } from '../lib/icons'
import { InlineError } from '../lib/InlineError'
import { PaidLock, PLAN_NAMES } from '../lib/plans'
import { plural } from '../lib/uploadRun'
import { useShop } from './AppLayout'
import { ShareDialog } from './ShareDialog'

// Обзор кабинета по макету 09 · Desktop · v2: четыре строки, разделённые
// линиями, в каждой — левый блок на 540px и правый на остатке ширины.
//
// «Поделиться» стоит в первой строке рядом со счётчиками: продавец
// отправляет ссылку по десять раз в день, это главное действие в кабинете.
export function OverviewPage() {
  const shop = useShop()
  // Берём 14 дней и делим пополам: так дельта к прошлой неделе считается
  // из одного ответа, без второго запроса и без правок бэкенда.
  // На Бесплатном аналитика закрыта (сервер ответит 403) — не спрашиваем.
  const free = shop.plan === 'free'
  const stats = useQuery({
    queryKey: ['stats', shop.id, 14],
    queryFn: () => api.getStats(shop.id, 14),
    enabled: !free,
  })
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const billing = useQuery({ queryKey: ['billing', shop.id], queryFn: () => api.getBilling(shop.id) })
  const [sharing, setSharing] = useState(false)
  // Макет предлагает считать расход и в фотографиях, и в гигабайтах:
  // лимит тарифа упирается то в одно, то в другое.
  // Если раньше кончится объём, блок сразу открывается в гигабайтах.
  const [unit, setUnit] = useState<'photos' | 'gb'>(() => {
    const byBytes = shop.storage_max > 0 ? shop.storage_used / shop.storage_max : 0
    return byBytes >= 0.9 ? 'gb' : 'photos'
  })
  const segRef = useSegThumb<HTMLDivElement>(unit)

  const shopUrl = `${location.origin}/${shop.slug}`
  // По дням, а не по записям: дней без просмотров в ответе нет, и
  // slice(-7) по сырому списку смешивал эту неделю с прошлой.
  const daily = fillDays(stats.data?.daily ?? [], 14)
  const week = daily.slice(-7)
  const prevWeek = daily.slice(-14, -7)
  const sum = (rows: typeof daily, key: 'views' | 'unique_visitors' | 'lead_clicks') =>
    rows.reduce((n, d) => n + d[key], 0)

  const photos = billing.data?.usage.photos
  // Корзина в блоке хранилища: удалённое продолжает занимать место, и без
  // этой строки продавец у лимита не понимает, куда оно делось.
  const trashPhotos = billing.data?.usage.trash_photos ?? 0
  const trashBytes = billing.data?.usage.trash_bytes ?? 0
  const num = (n: number) => n.toLocaleString('ru-RU')
  // «37,2 ГБ», «40 ГБ», «67 МБ»: меньше гигабайта — в мегабайтах, иначе
  // «0,0 ГБ» выглядело так, будто объём не считается вовсе.
  const size = (bytes: number) => {
    const gb = bytes / 1024 ** 3
    if (gb >= 1) {
      const v = Math.round(gb * 10) / 10
      return `${Number.isInteger(v) ? v : v.toFixed(1).replace('.', ',')} ГБ`
    }
    const mb = bytes / 1024 ** 2
    return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : num(Math.round(mb))} МБ`
  }

  // Состояния лимитов по макету 09 · «Лимит фото/объёма почти исчерпан» и
  // «исчерпан». Порог «почти» — 90%: раньше продавец узнавал о лимите
  // только по отказу загрузки посреди пачки.
  const NEAR = 0.9
  const photosLeft = photos === undefined ? undefined : shop.max_photos - photos
  const photosFull = photosLeft !== undefined && photosLeft <= 0
  // Фото больше лимита — тариф закончился, аккаунт перешёл на Бесплатный
  // (макет 09 · «Тариф закончился»): фото не удаляются, новые не загрузить.
  const photosOver = photosLeft !== undefined && photosLeft < 0
  const photosNear = photos !== undefined && !photosFull && photos >= shop.max_photos * NEAR
  const bytesLeft = shop.storage_max - shop.storage_used
  const gbFull = shop.storage_max > 0 && bytesLeft <= 0
  const gbNear = !gbFull && shop.storage_used >= shop.storage_max * NEAR

  // «Тариф скоро закончится» (макет 09/18): за 5 дней и только если
  // автопродление отключено — иначе тариф продлится сам.
  // «Сейчас» фиксируется при открытии страницы: счёт идёт на дни.
  const [now] = useState(() => Date.now())
  const b = billing.data
  const sub = b?.subscription ?? null
  // Пробный «Про» идёт, пока не оплачен и срок не вышел (как в «Подписке»).
  const paid = sub !== null && sub.status !== 'expired' && sub.plan === shop.plan && new Date(sub.period_end).getTime() > now
  const trialActive = !paid && !free && b?.trial_ends_at != null && new Date(b.trial_ends_at).getTime() > now
  // На Бесплатном: что закончилось последним — платный тариф или пробный.
  const subEnd = sub?.status === 'expired' ? new Date(sub.period_end).getTime() : 0
  const trialEnd = b?.trial_ends_at ? new Date(b.trial_ends_at).getTime() : 0
  const paidEnded = free && subEnd > 0 && subEnd >= trialEnd
  const trialEnded = free && !paidEnded && trialEnd > 0 && trialEnd <= now
  const freeLimits = b?.plans.find((x) => x.id === 'free')
  const freeLimitText = freeLimits ? `${num(freeLimits.max_photos)} фото и ${size(freeLimits.max_storage)}` : '…'
  const daysLeft = shop.paid_until ? Math.ceil((new Date(shop.paid_until).getTime() - now) / 86_400_000) : null
  const endingSoon =
    !free && !trialActive && b !== undefined && !sub?.auto_renew &&
    daysLeft !== null && daysLeft >= 0 && daysLeft <= 5

  // Новый аккаунт: альбомов ещё нет, цифры ни о чём не говорят.
  const fresh = albums.data?.length === 0
  // Пока данные грузятся — серые блоки на месте цифр (макет 09 · «Загрузка»).
  const skel = (w: string) => <span className={`skel skel--inline h-6 ${w}`} aria-hidden="true" />

  // Весь «Обзор» не загрузился (макет 09): вместо блоков — сообщение и
  // «Повторить»; меню и шапка остаются, чтобы уйти в другой раздел.
  // На Бесплатном статистику не спрашиваем — её ошибки там не бывает.
  if (albums.isError && billing.isError && (free || stats.isError)) {
    return (
      <div className="loadfail" role="alert">
        <i aria-hidden="true">
                <Icon as={WifiOff} size={28} />
              </i>
        <h2>Не удалось загрузить кабинет</h2>
        <p>Проверьте подключение к интернету и попробуйте ещё раз</p>
        <button
          className="btn btn--primary"
          onClick={() => {
            void albums.refetch()
            void stats.refetch()
            void billing.refetch()
          }}
        >
          <Icon as={RefreshCw} />
                Повторить
        </button>
      </div>
    )
  }

  return (
    <div className="ov">
      {fresh && (
        <div className="alert alert--info">
          <div className="alert__body">
            <b>Добро пожаловать в вуад!</b>
            <p>Создайте первый альбом и загрузите фото — потом поделитесь ссылкой на витрину с покупателями.</p>
            <div className="alert__actions">
              <Link to="/albums" search={{ create: true }} className="btn btn--primary btn--pill">
                Создать альбом
              </Link>
            </div>
          </div>
        </div>
      )}

      {endingSoon && (
        <div className="alert alert--warn">
          <div className="alert__body">
            <b>
              Тариф «{PLAN_NAMES[shop.plan]}»{' '}
              {daysLeft === 0
                ? 'заканчивается сегодня'
                : `закончится через ${daysLeft} ${plural(daysLeft!, 'день', 'дня', 'дней')}`}{' '}
              — {new Date(shop.paid_until!).toLocaleDateString('ru-RU')}
            </b>
            <p>
              После перехода на бесплатный тариф аналитика станет недоступна, лимит — {freeLimitText}: если
              загружено больше, новые фото добавить не получится. Ставить пароли на альбомы будет нельзя, а те, что
              уже стоят, сохранятся, но изменить или снять их не получится.
            </p>
            <div className="alert__actions">
              <Link to="/billing" className="btn btn--primary btn--pill">
                Продлить тариф
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Платный тариф или пробный «Про» закончился — аккаунт на Бесплатном
          (макеты 09 · «Тариф закончился», «Пробный период закончился»). */}
      {paidEnded && sub && (
        <div className="alert alert--danger">
          <div className="alert__body">
            <b>Тариф «{PLAN_NAMES[sub.plan]}» закончился — вы на бесплатном тарифе</b>
            <p>
              Добавлять пароли на альбомы больше нельзя. Пароли, которые уже стоят, сохранились, но изменить или снять
              их не получится. Продлите «{PLAN_NAMES[sub.plan]}», чтобы вернуть все возможности.
            </p>
            <div className="alert__actions">
              <Link to="/billing" className="btn btn--primary btn--pill">
                Продлить «{PLAN_NAMES[sub.plan]}»
              </Link>
            </div>
          </div>
        </div>
      )}
      {trialEnded && (
        <div className="alert alert--danger">
          <div className="alert__body">
            <b>Пробный период «Про» закончился — вы на бесплатном тарифе</b>
            <p>
              Аналитика недоступна, лимит — {freeLimitText}: если загружено больше, новые фото добавить не получится.
              Ставить пароли на альбомы нельзя, а те, что уже стоят, не получится изменить или снять. Оплатите «Про»,
              чтобы вернуть все возможности.
            </p>
            <div className="alert__actions">
              <Link to="/billing" className="btn btn--primary btn--pill">
                Оплатить «Про»
              </Link>
            </div>
          </div>
        </div>
      )}

      {photosFull && !photosOver && (
        <div className="alert alert--danger">
          <div className="alert__body">
            <b>
              Достигнут лимит фото — {num(photos!)} из {num(shop.max_photos)}
            </b>
            <p>
              Новые фото не загрузятся. Удалите лишние фото — в «Удаленном» они тоже занимают место — или
              перейдите на тариф с большим лимитом.
            </p>
            <div className="alert__actions">
              <Link to="/billing" className="btn btn--primary btn--pill">
                Сменить тариф
              </Link>
              <Link to="/trash" className="btn btn--ghost btn--pill">
                Открыть Удаленное
              </Link>
            </div>
          </div>
        </div>
      )}

      {gbFull && (
        <div className="alert alert--danger">
          <div className="alert__body">
            <b>
              Достигнут лимит объёма — {size(shop.storage_max)} из {size(shop.storage_max)}
            </b>
            <p>
              Новые фото не загрузятся{photosFull ? '' : ', хотя по количеству фото лимит ещё не исчерпан'}. Удалите
              лишние фото — в «Удаленном» они тоже занимают место — или перейдите на тариф с большим лимитом.
            </p>
            <div className="alert__actions">
              <Link to="/billing" className="btn btn--primary btn--pill">
                Сменить тариф
              </Link>
              <Link to="/trash" className="btn btn--ghost btn--pill">
                Открыть Удаленное
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Заголовок страницы для чтения с экрана — в макете его не видно. */}
      <h1 className="sr-only">Обзор</h1>
      <div className="ov__row ov__row--top">
        {/* Макет 09: слева заголовок и счётчики столбиком, справа кнопки. */}
        <section className="ovsec">
          <div className="ovsec__info">
          <div className="ov__head">
            <h2>Сведения об альбомах</h2>
          </div>
            <div className="counts">
              <p>
                <span>Альбомов: </span>
                <b>{albums.data ? num(albums.data.length) : skel('w-8')}</b>
              </p>
              {/* У лимита фото «Фото: N» выделено целиком (макет 09 · «Лимит фото»). */}
              <p className={photosNear || photosFull ? 'counts__hot' : undefined}>
                <span>Фото: </span>
                <b>{photos === undefined ? skel('w-12') : num(photos)}</b>
              </p>
            </div>
          </div>
            <div className="ovsec__acts">
              <Link to="/albums" className="btn btn--primary btn--sm btn--pill">
                Новый альбом
              </Link>
              <button onClick={() => setSharing(true)} className="btn btn--ghost btn--sm btn--pill">
                Поделиться
              </button>
            </div>
          {sharing && (
            <ShareDialog
              title="Поделиться витриной"
              lead="Отправьте ссылку покупателю или покажите QR-код"
              label="Ссылка на витрину"
              url={shopUrl}
              qr={`qr-${shop.slug}`}
              onClose={() => setSharing(false)}
            />
          )}
        </section>

        <TariffBlock
          shop={shop}
          billing={billing.isPending ? null : (b ?? null)}
          state={{ paid, trialActive, paidEnded, trialEnded, endingSoon }}
          fresh={fresh}
        />
      </div>

      <div className="ov__sep" />

      <div className="ov__row">
        <section>
          <div className="ov__head">
            <h2>Использование хранилища</h2>
            <div className="seg seg--fit" ref={segRef}>
              <button aria-pressed={unit === 'photos'} onClick={() => setUnit('photos')}>
                Фото
              </button>
              <button aria-pressed={unit === 'gb'} onClick={() => setUnit('gb')}>
                ГБ
              </button>
            </div>
          </div>
          {unit === 'photos' ? (
            photosFull && !photosOver ? (
              // Лимит исчерпан (макет 09): число мелкое серое, под ним — красная строка.
              <p className="ov__full">
                {num(photos!)} <span>/ из {num(shop.max_photos)} фото</span>
              </p>
            ) : (
              <p>
                <b className={`bignum ${photosOver ? 'bignum--full' : photosNear ? 'bignum--warn' : ''}`}>
                  {photos === undefined ? skel('h-8 w-20') : num(photos)}
                </b>
                <span>/ из {num(shop.max_photos)} фото</span>
              </p>
            )
          ) : gbFull ? (
            <p className="ov__full">
              {size(shop.storage_used)} <span>/ из {size(shop.storage_max)}</span>
            </p>
          ) : (
            <p>
              <b className={`bignum ${gbNear ? 'bignum--warn' : ''}`}>{size(shop.storage_used)}</b>
              <span>/ из {size(shop.storage_max)}</span>
            </p>
          )}
          {unit === 'photos' && photosNear && (
            <p className="ov__note ov__note--warn">
              Осталось {num(photosLeft!)} фото — удалите лишние или смените тариф
            </p>
          )}
          {unit === 'photos' && photosOver && (
            <p className="ov__note ov__note--full">
              Превышен лимит {free ? 'бесплатного тарифа' : 'тарифа'} — новые фото загрузить нельзя
            </p>
          )}
          {((unit === 'photos' && photosFull && !photosOver) || (unit === 'gb' && gbFull)) && (
            <p className="ov__note ov__note--full">Новые фото не загрузятся</p>
          )}
          {unit === 'gb' && gbNear && (
            <p className="ov__note ov__note--warn">
              Осталось {size(bytesLeft)} — удалите лишние фото или смените тариф
            </p>
          )}
          {/* Подсказка о лимите в другой единице: продавец смотрит на фото
              и не видит, что упёрся в гигабайты, и наоборот. */}
          {unit === 'photos' && (gbNear || gbFull) && !photosNear && !photosFull && (
            <p className="ov__note ov__note--warn">
              Место в хранилище заканчивается —{' '}
              <button className="font-medium underline" onClick={() => setUnit('gb')}>
                показать в ГБ
              </button>
            </p>
          )}
          {trashPhotos > 0 && (
            <p className="ov__trash">
              В Удаленном: {unit === 'gb' ? size(trashBytes) : `${num(trashPhotos)} фото`}{' '}
              <Link to="/trash">Открыть</Link>
            </p>
          )}
        </section>

        <section>
          <div className="ov__head">
            {/* Бесплатный (макет 09 · «Free-тариф»): заголовок «Аналитика»
                и замок вместо цифр. */}
            <h2>{free ? 'Аналитика' : 'За последние 7 дней'}</h2>
            {!free && <Link to="/stats">Вся статистика</Link>}
          </div>
          {/* Молчаливые нули при отказе статистики продавец читает как
              «витрину никто не смотрит» и идёт разбираться не туда. */}
          {free ? (
            <PaidLock text="Чтобы получить доступ к аналитике, перейдите на платный тариф." />
          ) : stats.isError ? (
            <InlineError text="Не удалось загрузить статистику" onRetry={() => void stats.refetch()} />
          ) : stats.isPending ? (
            <p aria-busy="true">{skel('h-8 w-40')}</p>
          ) : fresh ? (
            <p className="text-sm text-ink-3">
              Статистика появится, когда покупатели начнут открывать витрину
            </p>
          ) : (
            <p>
              <b className="bignum">{num(sum(week, 'views'))}</b>
              <span>{plural(sum(week, 'views'), 'просмотр', 'просмотра', 'просмотров')} витрины</span>
            </p>
          )}
          <div className={`ov__metrics flex flex-wrap gap-x-5 gap-y-1 py-2 ${free || stats.isError || stats.isPending || fresh ? 'hidden' : ''}`}>
            {delta(sum(week, 'views'), sum(prevWeek, 'views')).label && (
              <p className={delta(sum(week, 'views'), sum(prevWeek, 'views')).up ? 'text-[#1B6B3A]' : 'text-ink-3'}>
                <b className="font-semibold">{delta(sum(week, 'views'), sum(prevWeek, 'views')).label}</b>
                <span className="text-ink-3"> к прошлой неделе</span>
              </p>
            )}
            <p>
              <b className="font-semibold">{num(sum(week, 'lead_clicks'))}</b>
              <span className="text-ink-2"> переходов в мессенджер</span>
            </p>
            {/* Макет 09: «61 альбом открыт» — сколько разных альбомов смотрели
                за неделю. Отвечает на вопрос «смотрят ли каталог вглубь». */}
            <p>
              <b className="font-semibold">{num(stats.data?.albums_viewed_week ?? 0)}</b>
              <span className="text-ink-2">
                {' '}
                {plural(stats.data?.albums_viewed_week ?? 0, 'альбом открыт', 'альбома открыто', 'альбомов открыто')}
              </span>
            </p>
          </div>
        </section>
      </div>

      {/* «Быстрый доступ» — слева, на одной линии с остальными блоками.
          Ярлыки ведут в частые разделы; «Загрузить фото» сразу открывает окно. */}
      <div className="ov__sep" />
      <div className="ov__row ov__row--quick">
        <section>
          <div className="ov__head">
            <h2>Быстрый доступ</h2>
          </div>
          <nav className="quick" aria-label="Быстрый доступ">
            <Link to="/albums" search={{ upload: true }}>
              <Icon as={Upload} size={24} />
              Загрузить фото
            </Link>
            <Link to="/settings" hash="watermark">
              <Icon as={Droplet} size={24} />
              Водяной знак
            </Link>
            <Link to="/stats">
              <ChartIcon />
              Статистика витрины
            </Link>
            <Link to="/contacts">
              <Icon as={MessageCircle} size={24} />
              Контакты
            </Link>
            <Link to="/settings" hash="account">
              <Icon as={SlidersHorizontal} size={24} />
              Настройки аккаунта
            </Link>
            <Link to="/trash">
              <Icon as={Trash2} size={24} />
              Удаленное
            </Link>
          </nav>
        </section>
      </div>


      {/* Популярные альбомы: скелетон, пока грузятся, и своя ошибка с
          «Повторить» — остальной обзор при этом работает (макет 09). */}
      {!free && !fresh && (stats.isPending || stats.isError) && (
        <>
          <div className="ov__sep" />
          <section>
            <div className="ov__head">
              <h2>Что смотрят чаще всего</h2>
            </div>
            {stats.isError ? (
              <InlineError text="Не удалось загрузить популярные альбомы" onRetry={() => void stats.refetch()} />
            ) : (
              <div className="ovcards" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="skel block h-16" />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {(stats.data?.top_albums.length ?? 0) > 0 && (
        <>
          <div className="ov__sep" />
          <section>
            <div className="ov__head">
              <h2>Что смотрят чаще всего</h2>
              <span className="text-sm text-ink-3">за 7 дней</span>
            </div>
            <div className="ovcards">
              {stats.data!.top_albums.slice(0, 4).map((a) => {
                // Обложка — из списка альбомов: в статистике её нет, а серый
                // квадрат вместо фото ничего не говорил продавцу.
                const cover = albums.data?.find((x) => x.id === a.album_id)?.cover_urls?.small
                return (
                <Link key={a.album_id} to="/albums/$albumId" params={{ albumId: a.album_id }} className="ovcard">
                  <i aria-hidden="true">{cover && <img src={cover} alt="" loading="lazy" />}</i>
                  <span className="min-w-0">
                    <b>{a.title}</b>
                    <span>
                      {num(a.views)} {plural(a.views, 'просмотр', 'просмотра', 'просмотров')}
                    </span>
                  </span>
                </Link>
                )
              })}
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
  // Обе недели пустые — сравнивать нечего: строка «пока пусто к прошлой
  // неделе» читалась как сбой.
  if (prev === 0) return { label: value > 0 ? 'новые' : '', up: value > 0 }
  const pct = Math.round(((value - prev) / prev) * 100)
  if (pct === 0) return { label: 'столько же', up: false }
  return { label: `${pct > 0 ? '+' : ''}${pct}%`, up: pct > 0 }
}

// Блок «Тариф» (макет 09): строка срока и кнопки — по состоянию тарифа.
// Пока тариф грузится — серый блок на месте срока (макет 09 · «Загрузка»).
function TariffBlock({
  shop,
  billing: b,
  state,
  fresh,
}: {
  shop: Shop
  billing: Billing | null
  state: { paid: boolean; trialActive: boolean; paidEnded: boolean; trialEnded: boolean; endingSoon: boolean }
  fresh: boolean
}) {
  const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU')
  const free = shop.plan === 'free'
  const until = shop.paid_until
  let line: ReactNode
  if (!b) line = <span className="skel skel--inline h-5 w-40" aria-hidden="true" />
  else if (state.trialActive && b.trial_ends_at) line = <>Пробный период до {date(b.trial_ends_at)}</>
  else if (state.paidEnded && b.subscription) line = <>Платный тариф закончился<br />{date(b.subscription.period_end)}</>
  else if (state.trialEnded && b.trial_ends_at) line = <>Пробный период закончился {date(b.trial_ends_at)}</>
  else if (until && !free)
    line = (
      <>
        Действует до <b className={state.endingSoon ? 'ov__soon' : undefined}>{date(until)}</b>
      </>
    )
  else line = free ? 'Бесплатно, без срока' : 'Бессрочный'

  const ghost = 'btn btn--ghost btn--sm btn--pill'
  return (
    <section className="ovsec">
      <div className="ovsec__info">
        <div className="ov__head">
          <h2>Тариф «{PLAN_NAMES[shop.plan]}»</h2>
          {/* Телефон (макет 09 · Mobile): срок — справа в строке заголовка. */}
          {until && !free && !state.trialActive && (
            <span className="ov__until">
              до <b className={state.endingSoon ? 'ov__soon' : undefined}>{date(until)}</b>
            </span>
          )}
        </div>
        <p className={`ovsec__validity ${until && !free && !state.trialActive ? 'ov__validity' : ''}`}>{line}</p>
      </div>
      <div className="ovsec__acts">
        {state.trialActive ? (
          <Link to="/billing" className={ghost}>
            Оплатить «{PLAN_NAMES[shop.plan]}»
          </Link>
        ) : (
          <>
            {/* Бесплатный продлевать нечем — кроме случая, когда закончился платный. */}
            {(!free || state.paidEnded) && (
              <Link to="/billing" className={ghost}>
                Продлить
              </Link>
            )}
            <Link to="/billing" className={ghost}>
              Улучшить
            </Link>
          </>
        )}
        {/* Новому аккаунту платить ещё не за что — ссылки на платежи нет. */}
        {!fresh && (
          <Link to="/billing" className="ovsec__link">
            Платежи
          </Link>
        )}
      </div>
    </section>
  )
}
