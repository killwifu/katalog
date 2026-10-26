'use client'

import { useEffect, useState } from 'react'

// Продавец открыл витрину кнопкой «Мой профиль» из кабинета (?from=cabinet):
// показываем ему дорогу назад. Флаг живёт в sessionStorage, чтобы плашка
// не пропадала при переходах по витрине. Только на клиенте: страница
// кешируется (ISR) и одна на всех посетителей.
const KEY = 'katalog:from-cabinet'

export function BackToCabinet() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('from') === 'cabinet') sessionStorage.setItem(KEY, '1')
      setShow(sessionStorage.getItem(KEY) === '1')
    } catch {
      // Хранилище недоступно (приватный режим) — плашка не обязательна.
    }
  }, [])
  if (!show) return null
  return (
    <a href="/app/" className="back-to-cabinet">
      ← В кабинет
    </a>
  )
}
