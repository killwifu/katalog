import { useQuery } from '@tanstack/react-query'
import { fillDays } from '../lib/stats'
import { Droplet, MessageCircle, SlidersHorizontal, Trash2, Upload, RefreshCw, WifiOff } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useSegThumb } from '../lib/useSegThumb'
import { api } from '../api'
import { ChartIcon, Icon } from '../lib/icons'
import { InlineError } from '../lib/InlineError'
import { PLAN_NAMES } from '../lib/plans'
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
  const gbUsed = shop.storage_used / 1024 / 1024 / 1024
  const mbUsed = shop.storage_used / 1024 / 1024
  const gbMax = shop.storage_max / 1024 / 1024 / 1024
  const num = (n: number) => n.toLocaleString('ru-RU')

  // Состояния лимитов по макету 09 · «Лимит фото/объёма почти исчерпан» и
  // «исчерпан». Порог «почти» — 90%: раньше продавец узнавал о лимите
  // только по отказу загрузки посреди пачки.
  const NEAR = 0.9
  const photosLeft = photos === undefined ? undefined : shop.max_photos - photos
  const photosFull = photosLeft !== undefined && photosLeft <= 0
  const photosNear = photos !== undefined && !photosFull && photos >= shop.max_photos * NEAR
  const bytesLeft = shop.storage_max - shop.storage_used
  const gbFull = shop.storage_max > 0 && bytesLeft <= 0
  const gbNear = !gbFull && shop.storage_used >= shop.storage_max * NEAR
  const leftSize = (bytes: number) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`
      : `${Math.max(1, Math.round(bytes / 1024 / 1024))} МБ`

  // «Тариф скоро закончится»: предупреждаем за неделю.
  // «Сейчас» фиксируется при открытии страницы: счёт идёт на дни.
  const [now] = useState(() => Date.now())
  const daysLeft = shop.paid_until ? Math.ceil((new Date(shop.paid_until).getTime() - now) / 86_400_000) : null
  const endingSoon = shop.plan !== 'free' && shop.billing_state === 'ok' && daysLeft !== null && daysLeft >= 0 && daysLeft <= 7

  // Новый аккаунт: альбомов ещё нет, цифры ни о чём не говорят.
  const fresh = albums.data?.length === 0
  // Пока данные грузятся — серые блоки на месте цифр (макет 09 · «Загрузка»).
  const skel = (w: string) => <span className={`skel skel--inline h-6 ${w}`} aria-hidden="true" />

  // Весь «Обзор» не загрузился (макет 09): вместо блоков — сообщение и
  // «Повторить»; меню и шапка остаются, чтобы уйти в другой раздел.
  if (albums.isError && stats.isError && billing.isError) {
    return (
      <div className="loadfail" role="alert">
        <i aria-hidden="true">
                <Icon as={WifiOff} size={28} />
              </i>
        <h2>Не удалось загрузить обзор</h2>
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
      {/* Предложение выбрать видимое висит в кабинете, пока фотографий больше
          лимита: если продавец не выберет, мы всё равно ничего не удаляем. */}
      {downgrade.data?.over_limit && (
        <div className="alert alert--warn">
          {/* После сохранения выбора «Выберите…» звучало так, будто он
              не применился. */}
          {downgrade.data.visible_photos <= downgrade.data.max_photos ? (
            <span className="flex-1">
              Покупатели видят {downgrade.data.visible_photos} из {downgrade.data.total_photos}{' '}
              фото — остальные скрыты по тарифу и вернутся после продления.
            </span>
          ) : (
            <span className="flex-1">
              Фотографий больше, чем помещается в тариф: {downgrade.data.total_photos} из{' '}
              {downgrade.data.max_photos}. Выберите, что останется видимым покупателям.
            </span>
          )}
          <Link to="/downgrade" className="shrink-0 font-medium underline">
            {downgrade.data.visible_photos <= downgrade.data.max_photos ? 'Изменить' : 'Выбрать'}
          </Link>
        </div>
      )}

      {fresh && (
        <div className="alert alert--info">
          <div className="alert__body">
            <b>Добро пожаловать в Katalog!</b>
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
              Если не продлить, загрузка новых фото остановится, а позже витрина будет скрыта от покупателей.
              Фотографии при этом сохранятся.
            </p>
            <div className="alert__actions">
              <Link to="/billing" className="btn btn--primary btn--pill">
                Продлить тариф
              </Link>
            </div>
          </div>
        </div>
      )}

      {photosFull && (
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
              Достигнут лимит объёма — {gbMax.toFixed(0)} ГБ из {gbMax.toFixed(0)} ГБ
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
              <p>
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

        <section className="ovsec">
          <div className="ovsec__info">
          <div className="ov__head">
            {/* Макет 09 · «Free-тариф»: «Тариф Free · Бесплатно, без срока». */}
            <h2>{shop.plan === 'free' ? 'Тариф Free' : `Тариф «${PLAN_NAMES[shop.plan]}»`}</h2>
            {/* Телефон (макет 09 · Mobile): срок — справа в строке заголовка. */}
            {shop.paid_until && (
              <span className="ov__until">
                до <b>{new Date(shop.paid_until).toLocaleDateString('ru-RU')}</b>
              </span>
            )}
          </div>
            <p className={`ovsec__validity ${shop.paid_until ? 'ov__validity' : ''}`}>
              {shop.paid_until ? (
                <>
                  Действует до{' '}
                  <b>
                    {new Date(shop.paid_until).toLocaleDateString('ru-RU')}
                  </b>
                </>
              ) : shop.plan === 'free' ? (
                'Бесплатно, без срока'
              ) : (
                'Бессрочный'
              )}
            </p>
          </div>
            <div className="ovsec__acts">
              {/* Бесплатный тариф продлевать нечем — только улучшать. */}
              {shop.plan !== 'free' && (
                <Link to="/billing" className="btn btn--ghost btn--sm btn--pill">
                  Продлить
                </Link>
              )}
              <Link to="/billing" className="btn btn--ghost btn--sm btn--pill">
                Улучшить
              </Link>
              <Link to="/billing" className="ovsec__link">
                Платежи
              </Link>
            </div>
        </section>
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
            <p>
              <b className="bignum">{photos === undefined ? skel('h-8 w-20') : num(photos)}</b>
              <span>/ из {num(shop.max_photos)} фото</span>
            </p>
          ) : (
            <p>
              {/* Меньше гигабайта — в мегабайтах: «0,0 / из 5 ГБ» выглядело
                  так, будто объём не считается вовсе. */}
              <b className="bignum">
                {gbUsed >= 1 ? gbUsed.toFixed(1).replace('.', ',') : mbUsed < 10 ? mbUsed.toFixed(1).replace('.', ',') : num(Math.round(mbUsed))}
              </b>
              <span>
                {gbUsed >= 1 ? 'ГБ' : 'МБ'} / из {gbMax.toFixed(0)} ГБ
              </span>
            </p>
          )}
          {unit === 'photos' && photosNear && (
            <p className="mt-2 text-sm text-[#7A5310]">
              Осталось {num(photosLeft!)} фото — удалите лишние или смените тариф
            </p>
          )}
          {unit === 'gb' && gbNear && (
            <p className="mt-2 text-sm text-[#7A5310]">
              Осталось {leftSize(bytesLeft)} — удалите лишние фото или смените тариф
            </p>
          )}
          {/* Подсказка о лимите в другой единице: продавец смотрит на фото
              и не видит, что упёрся в гигабайты, и наоборот. */}
          {unit === 'photos' && (gbNear || gbFull) && !photosNear && !photosFull && (
            <p className="mt-2 text-sm text-[#7A5310]">
              Место в хранилище заканчивается —{' '}
              <button className="font-medium underline" onClick={() => setUnit('gb')}>
                показать в ГБ
              </button>
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
          <div className={`ov__metrics flex flex-wrap gap-x-5 gap-y-1 py-2 ${stats.isError || stats.isPending || fresh ? 'hidden' : ''}`}>
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

      {fresh && (
        <>
          <div className="ov__sep" />
          <section>
            <div className="ov__head">
              <h2>Что смотрят чаще всего</h2>
            </div>
            <p className="text-sm text-ink-3">Здесь будут альбомы, которые покупатели смотрят чаще всего</p>
          </section>
        </>
      )}

      {/* Популярные альбомы: скелетон, пока грузятся, и своя ошибка с
          «Повторить» — остальной обзор при этом работает (макет 09). */}
      {!fresh && (stats.isPending || stats.isError) && (
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
