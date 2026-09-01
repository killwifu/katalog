import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { createContext, useContext, useState } from 'react'
import { api, type Shop } from '../api'
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
const NAV = [
  { to: '/', label: 'Обзор' },
  { to: '/albums', label: 'Альбомы' },
  { to: '/categories', label: 'Категории' },
  { to: '/tabs', label: 'Вкладки' },
  { to: '/stats', label: 'Статистика' },
  { to: '/contacts', label: 'Контакты' },
  { to: '/settings', label: 'Настройки' },
  { to: '/billing', label: 'Тариф' },
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

  if (shops.isPending) {
    // Каркас, а не голый текст: без него первые секунды выглядят как
    // пустая страница, и продавец решает, что кабинет не открылся.
    return (
      <div className="app">
        <aside className="app__aside side">
          <div className="side__logo">Katalog</div>
        </aside>
        <div className="app__main text-ink-2">Загрузка…</div>
      </div>
    )
  }
  if (shops.isError) {
    return <div className="app__main text-danger">Не удалось загрузить данные. Обновите страницу.</div>
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

  const nav = (
    <nav className="flex flex-col gap-0.5" onClick={() => setMenuOpen(false)}>
      {NAV.map((item) => (
        <Link key={item.to} to={item.to} activeOptions={{ exact: item.to === '/' }}>
          {item.label}
        </Link>
      ))}
      {isAdmin && <Link to="/admin">Модерация</Link>}
    </nav>
  )

  return (
    <ShopContext.Provider value={shop}>
      <div className="app">
        <aside className="app__aside side">
          <div className="side__logo">{shop.name}</div>
          {nav}
          <div className="side__usage">
            <p>
              {photos === undefined ? '…' : photos.toLocaleString('ru-RU')} из{' '}
              {maxPhotos.toLocaleString('ru-RU')} фото
            </p>
            <div className="prog mt-2" aria-hidden="true">
              <span style={{ width: `${usedPct}%` }} />
            </div>
            <p>
              {usedMB} из {maxMB} МБ · тариф «{shop.plan}»
            </p>
          </div>
          <button onClick={() => void logout()} className="btn btn--quiet mt-4">
            Выйти
          </button>
        </aside>

        {/* Полоса телефона: до 860px бокового меню нет. */}
        <header className="app__bar">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label="Меню"
            className="btn btn--quiet"
          >
            ☰
          </button>
          <h1>{shop.name}</h1>
          <button onClick={() => void logout()} className="btn btn--quiet">
            Выйти
          </button>
        </header>

        <div className="app__main">
          {menuOpen && (
            <div className="side mb-4 rounded-card border md:hidden">
              {nav}
            </div>
          )}
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
          <Outlet />
        </div>
      </div>
    </ShopContext.Provider>
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
