'use client'

import { useState, type FormEvent } from 'react'

// Форма notice-and-takedown: без auth, POST в публичный API.
export function ComplaintForm() {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

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
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(body.message ?? `Ошибка ${res.status}`)
      }
      setState('done')
      form.reset()
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Не удалось отправить жалобу')
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
        <input name="url" type="url" required maxLength={1000} placeholder="https://…" />
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
