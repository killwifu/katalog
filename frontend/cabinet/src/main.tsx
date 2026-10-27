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
import { lazyPage } from './lib/lazyPage'
import { AlbumsPage } from './pages/AlbumsPage'
import { AppLayout } from './pages/AppLayout'
import { AdminPage } from './pages/AdminPage'
import { AuthPage } from './pages/AuthPage'
import { BillingPage } from './pages/BillingPage'
import { CaptionsPage } from './pages/CaptionsPage'
import { ErrorPage, NotFoundPage } from './pages/ErrorPage'
import { CheckEmailPage, ConfirmEmailPage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/PasswordPages'
import { captureIntent } from './lib/signupIntent'

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
// email — подставить почту («Войти» с регистрации и после смены пароля).
const redirectSearch = (s: Record<string, unknown>): { redirect?: string; email?: string } => ({
  ...(typeof s.redirect === 'string' && s.redirect.startsWith('/') && !s.redirect.startsWith('//')
    ? { redirect: s.redirect }
    : {}),
  ...(typeof s.email === 'string' ? { email: s.email } : {}),
})

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
  // Тариф с лендинга (lib/signupIntent): ?trial=1 или ?plan=…&period=year.
  // trial — числом: строку «1» роутер записал бы в адрес как %221%22.
  validateSearch: (s: Record<string, unknown>): { plan?: string; period?: string; trial?: 1 } => ({
    ...(typeof s.plan === 'string' ? { plan: s.plan } : {}),
    ...(typeof s.period === 'string' ? { period: s.period } : {}),
    ...(s.trial === 1 || s.trial === '1' ? { trial: 1 as const } : {}),
  }),
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

const confirmEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/confirm-email',
  validateSearch: tokenSearch,
  component: ConfirmEmailPage,
})

// «Подтвердите почту» (макет 05) — только с сессией неподтверждённого аккаунта.
const checkEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/check-email',
  beforeLoad: async () => {
    const me = await api.me().catch(() => null)
    if (!me) throw redirect({ to: '/login' })
    if (me.email_verified) throw redirect({ to: '/' })
  },
  component: CheckEmailPage,
})

// Все приватные экраны — под guard'ом сессии.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ location }) => {
    let me
    try {
      me = await api.me()
    } catch {
      throw redirect({ to: '/login', search: location.href === '/' ? {} : { redirect: location.href } })
    }
    // В кабинет — только с подтверждённой почтой (макет 05).
    if (!me.email_verified) throw redirect({ to: '/check-email' })
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
    confirmEmailRoute,
    checkEmailRoute,
    appRoute.addChildren([overviewRoute, albumsRoute, categoriesRoute, tabsRoute, contactsRoute, settingsRoute, albumRoute, captionsRoute, billingRoute, adminRoute, statsRoute, trashRoute]),
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

// Тариф из адреса (регистрация с лендинга, ссылка из письма, возврат из
// входа через Яндекс/VK) — до создания витрины.
captureIntent()
installModalFocusTrap()
installErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
