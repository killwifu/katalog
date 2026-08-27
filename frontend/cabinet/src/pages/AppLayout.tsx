import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { createContext, useContext, useState } from 'react'
import { api, type Shop } from '../api'
import { CreateShopPage } from './CreateShopPage'

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
  const [menuOpen, setMenuOpen] = useState(false)

  if (shops.isPending) {
    return <div className="app__main text-ink-2">Загрузка…</div>
  }
  if (shops.isError) {
    return <div className="app__main text-danger">Не удалось загрузить данные. Обновите страницу.</div>
  }

  const shop = shops.data[0]
  if (!shop) return <CreateShopPage />

  const logout = async () => {
    await api.logout()
    queryClient.clear()
    void navigate({ to: '/login' })
  }

  const isAdmin = me.data?.role === 'admin'
  const usedMB = Math.round(shop.storage_used / 1024 / 1024)
  const maxMB = Math.round(shop.storage_max / 1024 / 1024)
  const usedPct = shop.storage_max > 0 ? Math.min(100, (shop.storage_used / shop.storage_max) * 100) : 0

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
              {usedMB} из {maxMB} МБ
            </p>
            <div className="prog mt-2" aria-hidden="true">
              <span style={{ width: `${usedPct}%` }} />
            </div>
            <p>Тариф «{shop.plan}»</p>
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
          <BillingBanner state={shop.billing_state} />
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
