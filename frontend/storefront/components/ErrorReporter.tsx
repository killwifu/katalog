'use client'

import type { Breadcrumb, ErrorEvent as SentryEvent } from '@sentry/browser'
import { useEffect } from 'react'

// JS-ошибки витрины в Sentry. Бюджет — 100 КБ JS на страницу, поэтому ни
// SDK, ни запроса за DSN до первой ошибки нет: при ней берём DSN у API
// (/api/v1/public/config, пустой — отчёты выключены), грузим SDK отдельным
// чанком и отправляем её. Дальнейшие ошибки ловит уже сам SDK.
//
// Наружу не уходят IP, cookies, заголовки, тела запросов и query-строки.

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

async function report(error: unknown) {
  try {
    const r = await fetch('/api/v1/public/config')
    const c = r.ok ? ((await r.json()) as { sentry_dsn: string }) : null
    if (!c?.sentry_dsn) return
    const S = await import('@sentry/browser')
    S.init({
      dsn: c.sentry_dsn,
      initialScope: { tags: { component: 'storefront' } },
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      beforeSend: stripEvent,
      beforeBreadcrumb: stripBreadcrumb,
    })
    S.captureException(error)
  } catch {
    // Отчёт об ошибке не должен ломать страницу.
  }
}

export function ErrorReporter() {
  useEffect(() => {
    const onError = (e: Event) => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onError)
      void report(e instanceof PromiseRejectionEvent ? e.reason : (e as ErrorEvent).error)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onError)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onError)
    }
  }, [])
  return null
}
