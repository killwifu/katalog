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
import { installModalFocusTrap } from './lib/focusTrap'
import { installErrorReporting } from './lib/errorReport'
import { AlbumPage } from './pages/AlbumPage'
import { CategoriesPage } from './pages/CategoriesPage'
import { TabsPage } from './pages/TabsPage'
import { TrashPage } from './pages/TrashPage'
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

// Куда вернуть после входа: продавец открывал ссылку из письма (жалоба →
// /admin, оплата → /billing) и после входа оказывался на «Обзоре».
const redirectSearch = (s: Record<string, unknown>): { redirect?: string } =>
  typeof s.redirect === 'string' && s.redirect.startsWith('/') && !s.redirect.startsWith('//')
    ? { redirect: s.redirect }
    : {}

// Уже вошедшему форма входа ни к чему. Спрашиваем сервер, только если есть
// подсказка katalog_signed: иначе каждый аноним на форме входа получал
// 401 в консоли.
const skipIfSignedIn = async () => {
  if (!document.cookie.split('; ').some((c) => c.startsWith('katalog_signed='))) return
  const signedIn = await api.me().then(
    () => true,
    () => false,
  )
  if (signedIn) throw redirect({ to: '/' })
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: redirectSearch,
  beforeLoad: skipIfSignedIn,
  component: () => <AuthPage mode="login" />,
})

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  beforeLoad: skipIfSignedIn,
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
  beforeLoad: async ({ location }) => {
    try {
      await api.me()
    } catch {
      throw redirect({ to: '/login', search: location.href === '/' ? {} : { redirect: location.href } })
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
  // ?upload=1 — открыть «Загрузить фото» сразу (ярлык «Быстрого доступа» на обзоре);
  // ?create=1 — «Создать альбом» (кнопка приветствия нового продавца).
  validateSearch: (search: Record<string, unknown>): { upload?: boolean; create?: boolean } => {
    const on = (v: unknown) => v === true || v === 1 || v === '1'
    return { ...(on(search.upload) ? { upload: true } : {}), ...(on(search.create) ? { create: true } : {}) }
  },
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

const trashRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/trash',
  component: TrashPage,
})

const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    registerRoute,
    forgotPasswordRoute,
    resetPasswordRoute,
    verifyEmailRoute,
    appRoute.addChildren([overviewRoute, albumsRoute, categoriesRoute, tabsRoute, contactsRoute, downgradeRoute, settingsRoute, albumRoute, captionsRoute, billingRoute, adminRoute, statsRoute, trashRoute]),
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

installModalFocusTrap()
installErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
