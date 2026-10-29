'use client'

import type { ReactNode } from 'react'
import type { Plan } from '@/app/(marketing)/pricing/plans'

// Кнопка карточки тарифа (заметки макета 01, 02, 08). Адрес зависит от
// свитча «Помесячно / За год» (чекбокс #plan-year) и от того, вошёл ли
// продавец (html[data-auth]), поэтому считается в момент нажатия; в
// разметке — адрес по умолчанию: регистрация, помесячно.
//   не вошёл: «Начать бесплатно» → регистрация на Бесплатном,
//             «Пробный период» → регистрация с 7 днями «Про»,
//             «Выбрать …» → регистрация, затем оплата тарифа за период;
//   вошёл:    «Начать бесплатно» → кабинет, остальные → «Подписка» с тарифом.
export function planHref(plan: Plan['id'], year: boolean, signedIn: boolean): string {
  const period = year ? '&period=year' : ''
  if (signedIn) return plan === 'free' ? '/app/' : `/app/billing?plan=${plan}${period}`
  if (plan === 'free') return '/app/register'
  if (plan === 'pro') return '/app/register?trial=1'
  return `/app/register?plan=${plan}${period}`
}

export function PlanLink({ plan, className, children }: { plan: Plan['id']; className: string; children: ReactNode }) {
  // До нажатия, а не в onClick: средняя кнопка и «открыть в новой вкладке»
  // click не вызывают, но pointerdown/focus — да.
  const sync = (e: { currentTarget: HTMLAnchorElement }) => {
    const year = (document.getElementById('plan-year') as HTMLInputElement | null)?.checked ?? false
    e.currentTarget.href = planHref(plan, year, document.documentElement.dataset.auth === 'in')
  }
  return (
    <a className={className} href={planHref(plan, false, false)} onPointerDown={sync} onFocus={sync} onClick={sync}>
      {children}
    </a>
  )
}
