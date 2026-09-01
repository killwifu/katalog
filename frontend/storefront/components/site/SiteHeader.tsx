'use client'

import { usePathname } from 'next/navigation'
import { useState } from 'react'
import styles from './site.module.css'

// Шапка публичных страниц. Активный пункт определяется по пути,
// поэтому компонент клиентский; заодно на нём висит бургер-меню.
//
// Вход/кабинет: в разметке лежат оба варианта, лишний прячет CSS по
// атрибуту html[data-auth], который ставит инлайн-скрипт из layout ещё
// до первой отрисовки. Раньше маркер сессии читался в useEffect, и у
// вошедшего продавца на каждой загрузке мигало «Войти».

const NAV = [
  { href: '/', label: 'Главная' },
  { href: '/pricing', label: 'Тарифы' },
  { href: '/updates', label: 'Обновления' },
]

export function SiteHeader() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <header className={styles.head}>
      <div className={styles.headIn}>
        <button
          type="button"
          className={styles.burger}
          aria-label="Меню"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <a className={styles.logo} href="/">
          Katalog
        </a>

        <nav className={styles.nav}>
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className={styles.right}>
          <a className={`${styles.authIn} btn btn--light btn--sm`} href="/app/">
            Кабинет
          </a>
          <a className={`${styles.authOut} ${styles.login}`} href="/app/login">
            Войти
          </a>
          <a className={`${styles.authOut} btn btn--light btn--sm`} href="/app/register">
            Создать витрину
          </a>
        </div>
      </div>

      <nav className={`${styles.mobNav} ${open ? styles.mobNavOpen : ''}`}>
        {NAV.map((item) => (
          <a
            key={item.href}
            href={item.href}
            aria-current={pathname === item.href ? 'page' : undefined}
          >
            {item.label}
          </a>
        ))}
        <a className={styles.authIn} href="/app/">
          Кабинет
        </a>
        <a className={styles.authOut} href="/app/login">
          Войти
        </a>
        <a className={styles.authOut} href="/app/register">
          Создать витрину
        </a>
      </nav>
    </header>
  )
}
