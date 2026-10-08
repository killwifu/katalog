'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

// Форма notice-and-takedown: без auth, POST в публичный API.

// Сообщения API — английские и для разработчика; заявителю показываем,
// что именно поправить.
const ERRORS: Record<string, string> = {
  invalid_url: 'Проверьте ссылку: нужен адрес страницы или фото, начинающийся с https://',
  invalid_name: 'Укажите имя или название организации',
  invalid_email: 'Проверьте email — на него придёт ответ',
  invalid_reason: 'Опишите претензию: от 10 до 5000 символов',
  rate_limited: 'Слишком много попыток. Подождите минуту и отправьте снова',
}
export function ComplaintForm() {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  // Пришли по ссылке «Пожаловаться» со страницы витрины — адрес уже известен.
  const urlInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const from = new URLSearchParams(location.search).get('url')
    if (from && urlInput.current && !urlInput.current.value) urlInput.current.value = from
  }, [])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    setState('sending')
    setError('')
    try {
      const res = await fetch('/api/v1/public/complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: data.get('url'),
          reporter_name: data.get('reporter_name'),
          reporter_email: data.get('reporter_email'),
          reason: data.get('reason'),
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          (body.error && ERRORS[body.error]) ?? 'Не удалось отправить жалобу. Попробуйте ещё раз',
        )
      }
      setState('done')
      form.reset()
    } catch (err) {
      setState('error')
      // fetch падает TypeError'ом («Failed to fetch»), когда нет сети.
      setError(
        err instanceof TypeError
          ? 'Нет соединения. Проверьте интернет и отправьте снова'
          : err instanceof Error
            ? err.message
            : 'Не удалось отправить жалобу',
      )
    }
  }

  if (state === 'done') {
    return (
      <p className="form-success">
        Жалоба отправлена. Мы рассмотрим обращение и свяжемся с вами по email.
      </p>
    )
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="complaint-form">
      <label>
        Ссылка на контент
        <input ref={urlInput} name="url" type="url" required maxLength={1000} placeholder="https://…" />
      </label>
      <label>
        Ваше имя или организация
        <input name="reporter_name" required maxLength={200} />
      </label>
      <label>
        Email для связи
        <input name="reporter_email" type="email" required />
      </label>
      <label>
        Суть претензии
        <textarea
          name="reason"
          required
          minLength={10}
          maxLength={5000}
          rows={6}
          placeholder="Какие права нарушены и чем это подтверждается"
        />
      </label>
      <button type="submit" className="btn btn--primary" disabled={state === 'sending'}>
        {state === 'sending' ? 'Отправка…' : 'Отправить жалобу'}
      </button>
      {state === 'error' && <p className="form-error">{error}</p>}
    </form>
  )
}
