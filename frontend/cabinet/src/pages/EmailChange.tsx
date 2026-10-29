import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, errorText } from '../api'

// Смена почты для входа (макет 09 · «Подтверждение почты из настроек»):
// письмо уходит на новую почту, до перехода по ссылке она «Не подтверждена».
// Минимальный блок для раздела «Аккаунт» в «Настройках».
export function EmailChange() {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const change = useMutation({
    mutationFn: () => api.changeEmail(email.trim(), password),
    onSuccess: () => {
      setOpen(false)
      setEmail('')
      setPassword('')
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })
  const needPassword = me.data?.has_password !== false

  return (
    <div className="mb-4">
      <p className="text-sm text-ink-2">
        Почта для входа: {me.data?.email ?? 'не указана'}{' '}
        {!open && (
          <button type="button" className="text-brand hover:underline" onClick={() => setOpen(true)}>
            Изменить
          </button>
        )}
      </p>
      {me.data?.pending_email && (
        <p className="hint">
          <span className="badge">Не подтверждена</span> {me.data.pending_email} — перейдите по ссылке из письма
        </p>
      )}
      {open && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (email.trim() && (!needPassword || password)) change.mutate()
          }}
        >
          <label className="field">
            <span>Новая почта</span>
            <input className="inp" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {needPassword && (
            <label className="field">
              <span>Текущий пароль</span>
              <input className="inp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )}
          {change.isError && <p className="hint text-danger" role="alert">{errorText(change.error)}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn--ghost" disabled={change.isPending}>
              Отправить письмо
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
