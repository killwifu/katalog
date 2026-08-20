import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { createContext, useContext } from 'react'
import { api, type Shop } from '../api'
import { CreateShopPage } from './CreateShopPage'

const ShopContext = createContext<Shop | null>(null)

// useShop — текущий магазин (первый у пользователя); layout гарантирует наличие.
export function useShop(): Shop {
  const shop = useContext(ShopContext)
  if (!shop) throw new Error('useShop outside of AppLayout')
  return shop
}

export function AppLayout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const shops = useQuery({ queryKey: ['shops'], queryFn: api.listShops })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })

  if (shops.isPending) {
    return <div className="p-8 text-center text-gray-500">Загрузка…</div>
  }
  if (shops.isError) {
    return <div className="p-8 text-center text-red-600">Не удалось загрузить данные. Обновите страницу.</div>
  }

  const shop = shops.data[0]
  if (!shop) {
    return <CreateShopPage />
  }

  const logout = async () => {
    await api.logout()
    queryClient.clear()
    void navigate({ to: '/login' })
  }

  const usedMB = Math.round(shop.storage_used / 1024 / 1024)
  const maxMB = Math.round(shop.storage_max / 1024 / 1024)

  return (
    <ShopContext.Provider value={shop}>
      <div className="min-h-screen bg-gray-50">
        <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-4 py-3">
            <Link to="/" className="truncate font-semibold text-gray-900">
              {shop.name}
            </Link>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span className="hidden sm:inline">
                {usedMB} / {maxMB} МБ
              </span>
              <Link to="/tabs" className="text-gray-500 hover:text-gray-900">
                Вкладки
              </Link>
              <Link to="/categories" className="text-gray-500 hover:text-gray-900">
                Категории
              </Link>
              <Link to="/stats" className="text-gray-500 hover:text-gray-900">
                Статистика
              </Link>
              {me.data?.role === 'admin' && (
                <Link to="/admin" className="text-gray-500 hover:text-gray-900">
                  Модерация
                </Link>
              )}
              <Link to="/billing" className="text-gray-500 hover:text-gray-900">
                Тариф
              </Link>
              <button onClick={() => void logout()} className="text-gray-500 hover:text-gray-900">
                Выйти
              </button>
            </div>
          </div>
        </header>
        <BillingBanner state={shop.billing_state} />
        <main className="mx-auto max-w-4xl px-4 py-6">
          <Outlet />
        </main>
      </div>
    </ShopContext.Provider>
  )
}

// BillingBanner — статус подписки во всех экранах кабинета.
function BillingBanner({ state }: { state: Shop['billing_state'] }) {
  if (state === 'ok') return null
  const message =
    state === 'grace'
      ? 'Подписка не оплачена: загрузка фото заблокирована. Витрина будет скрыта после окончания льготного периода.'
      : 'Подписка не оплачена: витрина скрыта. Фото сохранены и вернутся после оплаты.'
  return (
    <div className="border-b border-red-200 bg-red-50">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-2 text-sm text-red-800">
        <span>{message}</span>
        <Link to="/billing" className="shrink-0 font-medium text-red-800 underline hover:text-red-900">
          Оплатить
        </Link>
      </div>
    </div>
  )
}
