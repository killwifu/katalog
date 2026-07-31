import { Link, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'register') {
        await api.register(email, password)
      } else {
        await api.login(email, password)
      }
      void navigate({ to: '/' })
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          invalid_credentials: 'Неверный email или пароль',
          email_taken: 'Этот email уже зарегистрирован',
          invalid_email: 'Некорректный email',
          weak_password: 'Пароль должен быть не короче 8 символов',
          rate_limited: 'Слишком много попыток, подождите минуту',
        }
        setError(messages[err.code] ?? err.message)
      } else {
        setError('Сеть недоступна, попробуйте ещё раз')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-lg bg-white p-6 shadow">
        <h1 className="mb-4 text-xl font-semibold text-gray-900">
          {mode === 'register' ? 'Регистрация' : 'Вход'}
        </h1>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-sm text-gray-600">Пароль</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          />
        </label>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {mode === 'register' ? 'Создать аккаунт' : 'Войти'}
        </button>
        <p className="mt-4 text-center text-sm text-gray-500">
          {mode === 'register' ? (
            <>
              Уже есть аккаунт?{' '}
              <Link to="/login" className="text-blue-600 hover:underline">
                Войти
              </Link>
            </>
          ) : (
            <>
              Нет аккаунта?{' '}
              <Link to="/register" className="text-blue-600 hover:underline">
                Зарегистрироваться
              </Link>
            </>
          )}
        </p>
      </form>
    </div>
  )
}
