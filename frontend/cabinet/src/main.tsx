import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { AlbumPage } from './pages/AlbumPage'
import { CategoriesPage } from './pages/CategoriesPage'
import { TabsPage } from './pages/TabsPage'
import { OverviewPage } from './pages/OverviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { ContactsPage } from './pages/ContactsPage'
import { DowngradePage } from './pages/DowngradePage'
import { lazyPage } from './lib/lazyPage'
import { AlbumsPage } from './pages/AlbumsPage'
import { AppLayout } from './pages/AppLayout'
import { AdminPage } from './pages/AdminPage'
import { AuthPage } from './pages/AuthPage'
import { BillingPage } from './pages/BillingPage'
import { CaptionsPage } from './pages/CaptionsPage'
import { ErrorPage, NotFoundPage } from './pages/ErrorPage'
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/PasswordPages'

// Recharts тяжёлый — страница статистики грузится отдельным чанком.
const StatsPage = lazyPage(() =>
  import('./pages/StatsPage').then((m) => ({ default: m.StatsPage })),
)
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
})

const rootRoute = createRootRoute({ component: Outlet })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => <AuthPage mode="login" />,
})

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: () => <AuthPage mode="register" />,
})

// Почтовые auth-потоки: без сессии (ссылки приходят в письмах).
const tokenSearch = (s: Record<string, unknown>): { token: string } => ({
  token: typeof s.token === 'string' ? s.token : '',
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: ForgotPasswordPage,
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: tokenSearch,
  component: ResetPasswordPage,
})

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  validateSearch: tokenSearch,
  component: VerifyEmailPage,
})

// Все приватные экраны — под guard'ом сессии.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async () => {
    try {
      await api.me()
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: AppLayout,
})

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: OverviewPage,
})

const albumsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/albums',
  component: AlbumsPage,
})

// remountDeps: смена альбома обязана перемонтировать страницу. Роутер по
// умолчанию переиспользует компонент при смене параметров, а Uppy на этой
// странице создаётся один раз — с albumId первого монтирования. Переход
// с одного альбома на другой напрямую (адресом или кнопкой «назад») оставлял
// загрузчик смотреть в прежний альбом, и фотографии молча уезжали не туда.
// Заодно сбрасываются номер страницы и плашка с итогом прошлой загрузки.
const albumRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/albums/$albumId',
  component: AlbumPage,
  remountDeps: ({ params }) => params.albumId,
})

// Тот же случай: проход по подписям держит позицию в состоянии компонента,
// и без перемонтирования она переезжала бы в другой альбом вместе с ней.
const captionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/albums/$albumId/captions',
  component: CaptionsPage,
  remountDeps: ({ params }) => params.albumId,
})

const categoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/categories',
  component: CategoriesPage,
})

const tabsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/tabs',
  component: TabsPage,
})

const contactsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/contacts',
  component: ContactsPage,
})

const downgradeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/downgrade',
  component: DowngradePage,
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsPage,
})

const billingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/billing',
  component: BillingPage,
})

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin',
  component: AdminPage,
})

const statsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stats',
  component: () => (
    <Suspense fallback={<p className="text-ink-2">Загрузка…</p>}>
      <StatsPage />
    </Suspense>
  ),
})

const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    registerRoute,
    forgotPasswordRoute,
    resetPasswordRoute,
    verifyEmailRoute,
    appRoute.addChildren([overviewRoute, albumsRoute, categoriesRoute, tabsRoute, contactsRoute, downgradeRoute, settingsRoute, albumRoute, captionsRoute, billingRoute, adminRoute, statsRoute]),
  ]),
  basepath: '/app',
  defaultErrorComponent: ({ error }) => <ErrorPage error={error} />,
  defaultNotFoundComponent: NotFoundPage,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
