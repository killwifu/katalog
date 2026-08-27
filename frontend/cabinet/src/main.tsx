import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { AlbumPage } from './pages/AlbumPage'
import { CategoriesPage } from './pages/CategoriesPage'
import { TabsPage } from './pages/TabsPage'
import { OverviewPage } from './pages/OverviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { ContactsPage } from './pages/ContactsPage'
import { AlbumsPage } from './pages/AlbumsPage'
import { AppLayout } from './pages/AppLayout'
import { AdminPage } from './pages/AdminPage'
import { AuthPage } from './pages/AuthPage'
import { BillingPage } from './pages/BillingPage'
import { CaptionsPage } from './pages/CaptionsPage'
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/PasswordPages'

// Recharts тяжёлый — страница статистики грузится отдельным чанком.
const StatsPage = lazy(() =>
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

const albumRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/albums/$albumId',
  component: AlbumPage,
})

const captionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/albums/$albumId/captions',
  component: CaptionsPage,
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
    appRoute.addChildren([overviewRoute, albumsRoute, categoriesRoute, tabsRoute, contactsRoute, settingsRoute, albumRoute, captionsRoute, billingRoute, adminRoute, statsRoute]),
  ]),
  basepath: '/app',
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
