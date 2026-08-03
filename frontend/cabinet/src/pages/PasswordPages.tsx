import { useMutation } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { api } from '../api'

// Страницы почтовых auth-потоков: запрос сброса пароля, установка нового
// пароля по токену из письма, подтверждение email.

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6">
        <h1 className="mb-4 text-lg font-semibold text-gray-900">{title}</h1>
        {children}
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none'
const buttonCls =
  'w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const send = useMutation({ mutationFn: () => api.forgotPassword(email) })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    send.mutate()
  }

  return (
    <AuthShell title="Сброс пароля">
      {send.isSuccess ? (
        <p className="text-sm text-gray-600">
          Если этот email зарегистрирован, мы отправили на него ссылку для
          сброса пароля. Проверьте почту.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className={inputCls}
          />
          <button type="submit" disabled={send.isPending || !email} className={buttonCls}>
            Отправить ссылку
          </button>
          {send.isError && (
            <p className="text-sm text-red-600">Не удалось отправить. Попробуйте ещё раз.</p>
          )}
        </form>
      )}
      <p className="mt-4 text-sm text-gray-500">
        <Link to="/login" className="text-blue-600 hover:underline">
          Вернуться ко входу
        </Link>
      </p>
    </AuthShell>
  )
}

export function ResetPasswordPage() {
  const { token } = useSearch({ from: '/reset-password' })
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const reset = useMutation({
    mutationFn: () => api.resetPassword(token, password),
    onSuccess: () => void navigate({ to: '/login' }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (password.length >= 8) reset.mutate()
  }

  if (!token) {
    return (
      <AuthShell title="Сброс пароля">
        <p className="text-sm text-red-600">
          Некорректная ссылка. Запросите сброс пароля заново.
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Новый пароль">
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Новый пароль (мин. 8 символов)"
          className={inputCls}
        />
        <button type="submit" disabled={reset.isPending || password.length < 8} className={buttonCls}>
          Сохранить пароль
        </button>
        {reset.isError && (
          <p className="text-sm text-red-600">
            Ссылка недействительна или устарела. Запросите сброс заново.
          </p>
        )}
      </form>
    </AuthShell>
  )
}

export function VerifyEmailPage() {
  const { token } = useSearch({ from: '/verify-email' })
  const verify = useMutation({ mutationFn: () => api.verifyEmail(token) })

  return (
    <AuthShell title="Подтверждение email">
      {verify.isSuccess ? (
        <p className="text-sm text-gray-600">
          Email подтверждён. Можно{' '}
          <Link to="/" className="text-blue-600 hover:underline">
            перейти в кабинет
          </Link>
          .
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Нажмите кнопку, чтобы подтвердить ваш email.
          </p>
          <button
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !token}
            className={buttonCls}
          >
            Подтвердить
          </button>
          {(verify.isError || !token) && (
            <p className="text-sm text-red-600">
              Ссылка недействительна или устарела.
            </p>
          )}
        </div>
      )}
    </AuthShell>
  )
}
