'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import styles from './site.module.css'

// Шапка публичных страниц. Активный пункт определяется по пути,
// поэтому компонент клиентский; заодно на нём висит бургер-меню.

const NAV = [
  { href: '/', label: 'Главная' },
  { href: '/pricing', label: 'Тарифы' },
  { href: '/updates', label: 'Обновления' },
  { href: '/remove-bg', label: 'Убрать фон' },
]

export function SiteHeader() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  // Страница статическая и отдаётся из кеша всем одинаково, поэтому о сессии
  // она узнать не может. Читаем маркер, который сервер кладёт рядом с сессией
  // при входе и снимает при выходе, — запроса к API это не стоит.
  //
  // Значение по умолчанию «не вошёл»: до гидратации разметка совпадает
  // с серверной, иначе React ругнётся на несовпадение.
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    setSignedIn(document.cookie.split('; ').some((c) => c.startsWith('katalog_signed=')))
  }, [])

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
          {signedIn ? (
            <a className="btn btn--light btn--sm" href="/app/">
              Кабинет
            </a>
          ) : (
            <>
              <a className={styles.login} href="/app/login">
                Войти
              </a>
              <a className="btn btn--light btn--sm" href="/app/register">
                Создать витрину
              </a>
            </>
          )}
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
        {signedIn ? (
          <a href="/app/">Кабинет</a>
        ) : (
          <>
            <a href="/app/login">Войти</a>
            <a href="/app/register">Создать витрину</a>
          </>
        )}
      </nav>
    </header>
  )
}
