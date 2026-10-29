'use client'

import { useEffect, useState } from 'react'
import s from './landing.module.css'

// Плашка о cookie при первом заходе (макет 04): закреплена внизу экрана,
// «Принять» скрывает её и запоминает выбор. Показывается после гидратации:
// страница статическая и одинакова для всех, а выбор живёт в браузере.
const KEY = 'cookie-consent'

export function CookieBanner() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    try {
      setShow(localStorage.getItem(KEY) !== '1')
    } catch {
      // Хранилище недоступно (приватный режим): не донимаем плашкой на каждом шаге.
    }
  }, [])
  if (!show) return null
  return (
    <div className={s.cookie} role="region" aria-label="Уведомление о cookie">
      <p>
        Мы используем файлы cookie, чтобы сайт работал корректно, и собираем обезличенную статистику посещений.
        Подробнее — в <a href="/privacy">Политике конфиденциальности</a>.
      </p>
      <button
        type="button"
        className={`${s.btn} ${s.btnPrimary}`}
        onClick={() => {
          try {
            localStorage.setItem(KEY, '1')
          } catch {
            // не запомнится — покажется на следующей странице
          }
          setShow(false)
        }}
      >
        Принять
      </button>
    </div>
  )
}
