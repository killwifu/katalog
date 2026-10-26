import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, CreditCard, Folder, LayoutDashboard, LayoutList, LogOut, MessageCircle, ShieldCheck, SlidersHorizontal, RefreshCw, Tag, Trash2, WifiOff, Menu as MenuIcon } from 'lucide-react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type Shop } from '../api'
import { ChartIcon, Icon } from '../lib/icons'
import { subscribeUploads, uploadsInFlight } from '../lib/inflight'
import { useMenuFocus } from '../lib/menuFocus'
import { PLAN_NAMES } from '../lib/plans'
import { OnboardingPage } from './OnboardingPage'

const ShopContext = createContext<Shop | null>(null)

// useShop — текущий магазин (первый у пользователя); layout гарантирует наличие.
export function useShop(): Shop {
  const shop = useContext(ShopContext)
  if (!shop) throw new Error('useShop outside of AppLayout')
  return shop
}

// Пункты меню одним списком: боковое меню на десктопе и выдвижное на телефоне
// строятся из него же, чтобы не разъезжались при правках.
// Порядок и названия — по макету 09 · v2: «Подписка» вместо «Тарифа»
// и «Аналитика» вместо «Статистики», аналитика ушла в конец списка.
// Иконки — только в меню телефона и планшета (макет 09 · Mobile · «Меню
// открыто»); в боковом меню компьютера их в макете нет, прячет CSS.
const NAV = [
  { to: '/', label: 'Обзор', icon: <Icon as={LayoutDashboard} className="nav__ico" /> },
  { to: '/albums', label: 'Альбомы', icon: <Icon as={Folder} className="nav__ico" /> },
  { to: '/categories', label: 'Категории', icon: <Icon as={Tag} className="nav__ico" /> },
  { to: '/tabs', label: 'Вкладки', icon: <Icon as={LayoutList} className="nav__ico" /> },
  { to: '/contacts', label: 'Контакты', icon: <Icon as={MessageCircle} className="nav__ico" /> },
  { to: '/settings', label: 'Настройки', icon: <Icon as={SlidersHorizontal} className="nav__ico" /> },
  { to: '/billing', label: 'Подписка', icon: <Icon as={CreditCard} className="nav__ico" /> },
  { to: '/stats', label: 'Аналитика', icon: <ChartIcon size={16} className="nav__ico" /> },
  { to: '/trash', label: 'Удаленное', icon: <Icon as={Trash2} className="nav__ico" /> },
] as const

export function AppLayout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const shops = useQuery({ queryKey: ['shops'], queryFn: api.listShops })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const shopId = shops.data?.[0]?.id
  const billing = useQuery({
    queryKey: ['billing', shopId],
    queryFn: () => api.getBilling(shopId!),
    enabled: Boolean(shopId),
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const bar = useRef<HTMLElement>(null)
  // Меню телефона/планшета закрывается по Esc и кликом мимо — как окна и
  // меню аккаунта.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    const outside = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', outside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', outside)
    }
  }, [menuOpen])

  if (shops.isPending || shops.isError) {
    // Каркас, а не голый текст: без него первые секунды выглядят как
    // пустая страница, и продавец решает, что кабинет не открылся.
    // Макет 09 · «Загрузка (скелетон)» и «Кабинет не загрузился».
    return (
      <div className="app">
        <aside className="app__aside side">
          <div className="side__logo">Katalog</div>
          {/* Меню остаётся и при ошибке (макет 09 · «Кабинет не загрузился»). */}
          {shops.isError && (
            <nav className="flex flex-col gap-0.5" aria-label="Разделы кабинета">
              {NAV.map((item) => (
                <Link key={item.to} to={item.to}>
                  {item.label}
                </Link>
              ))}
            </nav>
          )}
          {shops.isPending && (
            <div className="mt-4 grid gap-3 px-3" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className="skel block h-4" style={{ width: `${60 + ((i * 17) % 30)}%` }} />
              ))}
            </div>
          )}
        </aside>
        {shops.isPending ? (
          <main className="app__main" aria-busy="true" aria-label="Загрузка кабинета">
            <span className="skel mb-6 block h-8 w-56" />
            <div className="grid gap-4 md:grid-cols-2">
              <span className="skel block h-40" />
              <span className="skel block h-40" />
              <span className="skel block h-40" />
              <span className="skel block h-40" />
            </div>
          </main>
        ) : (
          <main className="app__main">
            <div className="loadfail" role="alert">
              <i aria-hidden="true">
                <Icon as={WifiOff} size={28} />
              </i>
              <h2>Не удалось загрузить кабинет</h2>
              <p>Проверьте подключение к интернету и попробуйте ещё раз</p>
              <button className="btn btn--primary" onClick={() => void shops.refetch()} disabled={shops.isFetching}>
                <Icon as={RefreshCw} />
                Повторить
              </button>
            </div>
          </main>
        )}
      </div>
    )
  }

  const shop = shops.data[0]
  if (!shop) return <OnboardingPage />

  const logout = async () => {
    await api.logout()
    queryClient.clear()
    void navigate({ to: '/login' })
  }

  const isAdmin = me.data?.role === 'admin'
  // Лимит тарифа продавец считает в фотографиях, поэтому в меню они,
  // а место — второй строкой.
  const photos = billing.data?.usage.photos
  const maxPhotos = shop.max_photos
  const usedMB = Math.round(shop.storage_used / 1024 / 1024)
  const maxMB = Math.round(shop.storage_max / 1024 / 1024)
  const usedPct = maxPhotos > 0 && photos !== undefined ? Math.min(100, (photos / maxPhotos) * 100) : 0
  const storagePct = shop.storage_max > 0 ? Math.min(100, (shop.storage_used / shop.storage_max) * 100) : 0
  // Что ближе к пределу — то и показываем; от 90% жёлтое, на пределе красное.
  const byStorage = storagePct > usedPct
  const worst = Math.max(storagePct, usedPct)
  const level: 'ok' | 'warn' | 'full' = worst >= 100 ? 'full' : worst >= 90 ? 'warn' : 'ok'
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1).replace('.', ',')

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Разделы кабинета" onClick={() => setMenuOpen(false)}>
      {NAV.map((item) => (
        <Link key={item.to} to={item.to} activeOptions={{ exact: item.to === '/' }}>
          {item.icon}
          {item.label}
        </Link>
      ))}
      {isAdmin && (
        <Link to="/admin">
          <Icon as={ShieldCheck} className="nav__ico" />
          Модерация
        </Link>
      )}
    </nav>
  )

  return (
    <ShopContext.Provider value={shop}>
      <div className="app">
        <aside className="app__aside side">
          <div className="side__logo">{shop.name}</div>
          {nav}
          {/* Макет 09 · v2: в меню осталось «сколько занято», а тариф и место
              в гигабайтах переехали в «Обзор» — там для них есть строка. */}
          <div className={`side__usage ${level === 'ok' ? '' : `side__usage--${level}`}`}>
            <p>Использовано</p>
            <div className={`prog mt-2 ${level === 'ok' ? '' : `prog--${level}`}`} aria-hidden="true">
              <span style={{ width: `${byStorage ? storagePct : usedPct}%` }} />
            </div>
            {/* Лимит считается и по фото, и по объёму — показываем тот, что
                кончится раньше (макет 09 · «Лимит объёма почти исчерпан»). */}
            {byStorage ? (
              <p title={`${photos ?? '…'} из ${maxPhotos} фото · тариф «${PLAN_NAMES[shop.plan]}»`}>
                {gb(shop.storage_used)} из {gb(shop.storage_max)} ГБ
              </p>
            ) : (
              <p title={`${usedMB} из ${maxMB} МБ · тариф «${PLAN_NAMES[shop.plan]}»`}>
                {photos === undefined ? '…' : photos.toLocaleString('ru-RU')} из{' '}
                {maxPhotos.toLocaleString('ru-RU')} фото
              </p>
            )}
          </div>
        </aside>

        {/* Полоса телефона: до 860px бокового меню нет. */}
        {/* Шапка телефона (макет 09/10 · Mobile): название слева, справа
            «Мой профиль» и меню. */}
        <header className="app__bar" ref={bar}>
          <p className="app__shop">{shop.name}</p>
          <a href={`/${shop.slug}?from=cabinet`} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">
            Мой профиль
          </a>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label="Меню"
            className="btn btn--quiet"
          >
            <Icon as={MenuIcon} size={20} />
          </button>
          {/* Меню телефона (макет 09 · Mobile · «Меню открыто»): карточка под
              бургером поверх страницы. «Выйти» — здесь, за чертой: в шапке
              телефона было три цели, и самой опасной досталось бы постоянное место. */}
          {menuOpen && (
            <div className="app__menu">
              {nav}
              <hr />
              <button onClick={() => void logout()}>
                <Icon as={LogOut} className="nav__ico" />
                Выйти
              </button>
            </div>
          )}
        </header>

        <div className="app__main">
          {/* Макет 09 · v2 · «Меню аккаунта»: выход уехал из бокового меню
              сюда, под название витрины. На телефоне этой полосы нет —
              там выход лежит в выдвижном меню. */}
          <header className="app__top">
            <AccountMenu shop={shop} onLogout={() => void logout()} />
            <a href={`/${shop.slug}?from=cabinet`} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">
              Мой профиль
            </a>
          </header>
          {/* Ориентир «основное содержимое» для чтения с экрана — только тело
              страницы, без шапки с аккаунтом. */}
          <main className="app__body">
          {shop.status === 'suspended' ? (
            <div className="alert alert--danger">
              <span className="flex-1">
                Магазин заблокирован модератором: витрина скрыта, загрузка
                фотографий недоступна. Всё содержимое сохранено. Если считаете
                блокировку ошибкой — напишите в поддержку.
              </span>
            </div>
          ) : (
            <BillingBanner state={shop.billing_state} />
          )}
          <UploadsBanner />
          <Outlet />
          </main>
        </div>
      </div>
    </ShopContext.Provider>
  )
}

// Загрузка продолжается, когда продавец ушёл со страницы альбома, — и об
// этом должно быть видно, иначе вкладку закрывают посреди пачки. На самой
// странице альбома своя строка прогресса.
function UploadsBanner() {
  const n = useSyncExternalStore(subscribeUploads, uploadsInFlight)
  const onAlbum = useRouterState({ select: (s) => /^(\/app)?\/albums\/[^/]+\/?$/.test(s.location.pathname) })
  if (n === 0 || onAlbum) return null
  return (
    <div className="alert alert--warn" role="status">
      <span className="flex-1">
        Загружается {n} фото — не закрывайте вкладку, пока загрузка не закончится.
      </span>
    </div>
  )
}

// BillingBanner — статус подписки виден на всех экранах кабинета.
function BillingBanner({ state }: { state: Shop['billing_state'] }) {
  if (state === 'ok') return null
  const grace = state === 'grace'
  return (
    <div className={`alert ${grace ? 'alert--warn' : 'alert--danger'}`}>
      <span className="flex-1">
        {grace
          ? 'Подписка не оплачена: загрузка фото заблокирована. Витрина будет скрыта после окончания льготного периода.'
          : 'Подписка не оплачена: витрина скрыта. Фотографии сохранены и вернутся после оплаты.'}
      </span>
      <Link to="/billing" className="shrink-0 font-medium underline">
        Оплатить
      </Link>
    </div>
  )
}

// Меню аккаунта по макету 09 · v2. Закрывается кликом мимо и по Escape.
function AccountMenu({ shop, onLogout }: { shop: Shop; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setOpen(false), [])
  useMenuFocus(open, closeMenu, box, '.acct__menu')
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  // Две буквы названия вместо аватара: картинки профиля у витрины нет.
  const initials = shop.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

  return (
    <div className="acct" ref={box}>
      <button className="acct__btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i aria-hidden="true">{initials}</i>
        <span>{shop.slug}</span>
        <Icon as={open ? ChevronUp : ChevronDown} size={16} />
      </button>
      {open && (
        <div className="acct__menu popmenu" role="menu" onClick={() => setOpen(false)}>
          <Link to="/albums" role="menuitem">
            <Icon as={Folder} size={18} />
            Мои альбомы
          </Link>
          <Link to="/settings" hash="account" role="menuitem">
            <Icon as={SlidersHorizontal} size={18} />
            Настройки аккаунта
          </Link>
          <button role="menuitem" onClick={onLogout}>
            <Icon as={LogOut} size={18} />
            Выйти
          </button>
        </div>
      )}
    </div>
  )
}
