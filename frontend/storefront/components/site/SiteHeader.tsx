'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import s from './landing.module.css'

// Шапка публичных страниц (макет 01, меню — 06). Активный пункт — по пути,
// поэтому компонент клиентский; на нём же полноэкранное мобильное меню.
//
// Вход/кабинет: в разметке лежат оба варианта, лишний прячет CSS по
// атрибуту html[data-auth] (классы auth-in / auth-out в globals.css),
// который инлайн-скрипт из layout ставит ещё до первой отрисовки.
// Пункта «Обновления» из макета нет: страница убрана решением владельца.

const NAV = [
  { href: '/', label: 'Главная' },
  { href: '/pricing', label: 'Тарифы' },
]

export function SiteHeader() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // Меню поверх страницы: под ним страница не прокручивается, Esc закрывает.
  useEffect(() => {
    if (!open) return
    document.documentElement.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      document.documentElement.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const links = NAV.map((item) => (
    <a key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
      {item.label}
    </a>
  ))

  return (
    <header className={s.head}>
      <div className={`${s.in} ${s.headIn}`}>
        <a className={s.logo} href="/">
          вуад
        </a>
        <nav className={s.nav}>{links}</nav>

        <div className={s.headRight}>
          <a className={`auth-out ${s.btn} ${s.btnText}`} href="/app/login">
            Войти
          </a>
          <a className={`auth-out ${s.btn} ${s.btnPrimary}`} href="/app/register">
            Создать аккаунт
          </a>
          <a className={`auth-in ${s.btn} ${s.btnPrimary}`} href="/app/">
            Перейти в кабинет
          </a>
        </div>

        <button
          type="button"
          className={s.burger}
          aria-label={open ? 'Закрыть меню' : 'Меню'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      {open && (
        <div className={s.menu}>
          <nav className={s.menuNav}>{links}</nav>
          <div className={s.menuActions}>
            <a className={`auth-out ${s.btn} ${s.btnOutline}`} href="/app/login">
              Войти
            </a>
            <a className={`auth-out ${s.btn} ${s.btnPrimary}`} href="/app/register">
              Создать аккаунт
            </a>
            <a className={`auth-in ${s.btn} ${s.btnPrimary}`} href="/app/">
              Перейти в кабинет
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
