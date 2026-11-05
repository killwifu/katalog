'use client'

import { X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

// Поиск по названиям альбомов (макет 15). Результаты обновляются по мере
// ввода: через паузу в наборе уходим на /{slug}/search?q=… (сервер отдаёт
// готовую сетку). Без JS остаётся обычная GET-форма по Enter. from — откуда
// пришли: «Сбросить поиск», крестик и очищенное поле возвращают туда.
const DELAY = 300
// Шапка витрины — часть страницы, а не общего layout: при переходе
// с главной на /search поле монтируется заново. Флаг возвращает в него
// фокус и каретку, чтобы набор не прерывался.
const KEEP_FOCUS = 'search-focus'

export function SearchForm({ slug, initial, from }: { slug: string; initial?: string; from: string }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<number>()
  const action = `/${encodeURIComponent(slug)}/search`

  useEffect(() => {
    let keep = false
    try {
      keep = sessionStorage.getItem(KEEP_FOCUS) === '1'
      sessionStorage.removeItem(KEEP_FOCUS)
    } catch {}
    const el = input.current
    if (keep && el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
    return () => window.clearTimeout(timer.current)
  }, [])

  function onInput(value: string) {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const q = value.trim()
      if (q === (initial ?? '')) return
      try {
        sessionStorage.setItem(KEEP_FOCUS, '1')
      } catch {}
      // Первый символ на обычной странице — новая запись в истории («Назад»
      // вернёт на витрину), дальнейший набор её только уточняет.
      const href = q ? `${action}?q=${encodeURIComponent(q)}&from=${encodeURIComponent(from)}` : from
      if (initial) router.replace(href, { scroll: false })
      else router.push(href, { scroll: false })
    }, DELAY)
  }

  return (
    <form className="search-form" action={action} method="get">
      <input
        ref={input}
        type="search"
        name="q"
        defaultValue={initial ?? ''}
        onChange={(e) => onInput(e.target.value)}
        placeholder="Поиск по альбомам"
        maxLength={100}
        required
        aria-label="Поиск по альбомам магазина"
      />
      <input type="hidden" name="from" value={from} />
      {initial && (
        <a className="search-form__clear" href={from} aria-label="Сбросить поиск">
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </a>
      )}
      {/* Кнопки в макете нет. Сама кнопка остаётся для скринридера
          и для клавиатуры телефона («Найти»). */}
      <button type="submit" className="sr-only">
        Найти
      </button>
    </form>
  )
}
