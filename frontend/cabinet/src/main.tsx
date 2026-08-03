import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { AlbumPage } from './pages/AlbumPage'
import { AlbumsPage } from './pages/AlbumsPage'
import { AppLayout } from './pages/AppLayout'
import { AuthPage } from './pages/AuthPage'
import { BillingPage } from './pages/BillingPage'
import { CaptionsPage } from './pages/CaptionsPage'
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

const albumsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
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

const billingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/billing',
  component: BillingPage,
})

const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    registerRoute,
    appRoute.addChildren([albumsRoute, albumRoute, captionsRoute, billingRoute]),
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
