import type { Breadcrumb, ErrorEvent as SentryEvent } from '@sentry/browser'

// Ошибки кабинета в Sentry.
//
// SDK и DSN грузятся только при первой ошибке: DSN отдаёт API
// (/api/v1/public/config, пустой — отчёты выключены), поэтому образ не
// пересобирается под окружение, а без ошибок кабинет не платит ни запросом,
// ни килобайтом. После init глобальные ошибки ловит уже сам SDK.
//
// Наружу не уходят IP, cookies, заголовки, тела запросов и query-строки
// адресов (в них бывает токен сброса пароля).

type Sentry = typeof import('@sentry/browser')
let ready: Promise<Sentry | null> | undefined

const noQuery = (u: string) => u.split('?')[0]

function stripEvent(e: SentryEvent): SentryEvent {
  if (e.request?.url) e.request.url = noQuery(e.request.url)
  return e
}

function stripBreadcrumb(b: Breadcrumb): Breadcrumb {
  for (const k of ['url', 'from', 'to']) {
    if (typeof b.data?.[k] === 'string') b.data[k] = noQuery(b.data[k])
  }
  return b
}

function load(): Promise<Sentry | null> {
  ready ??= fetch('/api/v1/public/config')
    .then((r) => (r.ok ? (r.json() as Promise<{ sentry_dsn: string }>) : null))
    .then(async (c) => {
      if (!c?.sentry_dsn) return null
      const S = await import('@sentry/browser')
      S.init({
        dsn: c.sentry_dsn,
        // v11 по умолчанию собирает cookies, заголовки, тела запросов и
        // user.* (в т.ч. IP) — продавцу и покупателю это ни к чему.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
        },
        initialScope: { tags: { component: 'cabinet' } },
        beforeSend: stripEvent,
        beforeBreadcrumb: stripBreadcrumb,
      })
      return S
    })
    .catch(() => null)
  return ready
}

export function reportError(error: unknown) {
  void load().then((S) => S?.captureException(error))
}

export function installErrorReporting() {
  const onError = (e: Event) => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onError)
    reportError(e instanceof PromiseRejectionEvent ? e.reason : (e as ErrorEvent).error)
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onError)
}
