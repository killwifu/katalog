import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, errorText } from '../api'
import { readIntent } from '../lib/signupIntent'
import { setRegistrationDraft } from './AuthPage'
import { AuthHead, AuthShell, EMAIL_RE, Field, FieldError, ResendButton, StatusIcon, useCooldown } from './AuthShell'

// Экраны почтовых потоков (макеты 05 и 07): «Подтвердите почту», переход по
// ссылке подтверждения, восстановление пароля, подтверждение новой почты.

// Макет 05 · «Подтвердите почту»: после регистрации и при входе с
// неподтверждённой почтой. Письмо к этому моменту уже ушло — отсчёт 60 с.
export function CheckEmailPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Почту могли подтвердить в другой вкладке или на телефоне — проверяем
  // и сами уходим на создание витрины.
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 5000 })
  const [left, restart] = useCooldown(60)
  const [error, setError] = useState('')
  const resend = useMutation({
    mutationFn: () => api.resendVerification(readIntent()),
    onSuccess: () => {
      setError('')
      restart()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'resend_too_soon') restart()
      else setError(errorText(e))
    },
  })

  useEffect(() => {
    if (me.data?.email_verified) void navigate({ to: '/' })
  }, [me.data?.email_verified, navigate])

  // «Изменить почту» — аккаунт ещё пустой, удаляем его и возвращаемся
  // к регистрации с заполненными полями (заметка макета).
  const change = async () => {
    const email = me.data?.email ?? ''
    try {
      await api.cancelRegistration()
    } catch {
      // Уже подтверждён — регистрация не нужна.
      void navigate({ to: '/' })
      return
    }
    queryClient.clear()
    setRegistrationDraft({ email, password: '' })
    const i = readIntent()
    void navigate({ to: '/register', search: i.trial ? { trial: 1 as const } : i.plan ? { plan: i.plan, ...(i.period === 'year' ? { period: 'year' } : {}) } : {} })
  }

  return (
    <AuthShell>
      <StatusIcon kind="mail" />
      <AuthHead
        title="Подтвердите почту"
        lead={
          <>
            Мы отправили письмо на <b>{me.data?.email ?? '…'}</b>. Перейдите по ссылке из письма — и продолжим.
          </>
        }
      />
      <p className="au-small">Письма нет? Проверьте папку «Спам».</p>
      <div className="au__stack">
        <ResendButton left={left} busy={resend.isPending} onClick={() => resend.mutate()} />
        {error && <FieldError>{error}</FieldError>}
        <button type="button" className="au-center lnk" onClick={() => void change()}>
          Изменить почту
        </button>
      </div>
    </AuthShell>
  )
}

// Переход по ссылке из письма «Подтвердите почту»: подтверждаем сразу,
// без лишней кнопки, и ведём на создание витрины (заметка макета 05).
// Ссылка устарела — экран «Ссылка устарела» с новым письмом.
export function VerifyEmailPage() {
  const { token } = useSearch({ from: '/verify-email' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const started = useRef(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // StrictMode запускает эффект дважды — одноразовый токен второй раз
    // уже не сработал бы.
    if (started.current) return
    started.current = true
    api.verifyEmail(token).then(
      () => {
        queryClient.clear()
        void navigate({ to: '/' })
      },
      () => setFailed(true),
    )
  }, [token, navigate, queryClient])

  if (!failed) {
    return (
      <AuthShell>
        <AuthHead title="Подтверждаем почту…" />
      </AuthShell>
    )
  }
  return <VerifyLinkExpired />
}

function VerifyLinkExpired() {
  const navigate = useNavigate()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: 0 })
  const resend = useMutation({
    mutationFn: () => api.resendVerification(readIntent()),
    onSettled: (_d, e) => {
      // Письмо отправлено или уже отправлялось минуту назад — в обоих
      // случаях дальше экран «Подтвердите почту» с таймером.
      if (!e || (e instanceof ApiError && e.code === 'resend_too_soon')) void navigate({ to: '/check-email' })
    },
  })
  useEffect(() => {
    if (me.data?.email_verified) void navigate({ to: '/' })
  }, [me.data?.email_verified, navigate])

  return (
    <AuthShell>
      <StatusIcon kind="error" />
      {me.data ? (
        <>
          <AuthHead
            title="Ссылка устарела"
            lead={
              <>
                Ссылка из письма больше не действует.
                <br />
                Отправим новую на <b>{me.data.email}</b>.
              </>
            }
          />
          <button type="button" className="btn btn--primary au-btn" disabled={resend.isPending} onClick={() => resend.mutate()}>
            Отправить новое письмо
          </button>
          {resend.isError && !(resend.error instanceof ApiError && resend.error.code === 'resend_too_soon') && (
            <FieldError>{errorText(resend.error)}</FieldError>
          )}
        </>
      ) : (
        // Без сессии почту не знаем: после входа новое письмо уйдёт само.
        <>
          <AuthHead title="Ссылка устарела" lead="Ссылка из письма больше не действует. Войдите — и мы отправим новую." />
          <Link to="/login" className="btn btn--primary au-btn">
            Войти
          </Link>
        </>
      )}
    </AuthShell>
  )
}

// Макет 07 · «Восстановление пароля»: ввод почты -> «Проверьте почту».
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [left, restart] = useCooldown(60)
  const send = useMutation({
    mutationFn: () => api.forgotPassword(email.trim()),
    onSuccess: () => {
      setSent(true)
      restart()
    },
    onError: (e) => setError(errorText(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!EMAIL_RE.test(email.trim())) {
      setError('Проверьте адрес почты — похоже, в нём ошибка')
      return
    }
    send.mutate()
  }

  const back = (
    <Link to="/login" className="au-center lnk">
      Вернуться ко входу
    </Link>
  )

  if (sent) {
    // Есть такая почта или нет — экран один и тот же (заметка макета).
    return (
      <AuthShell>
        <StatusIcon kind="mail" />
        <AuthHead
          title="Проверьте почту"
          lead={
            <>
              Отправили ссылку для сброса пароля на <b>{email.trim()}</b>.
            </>
          }
        />
        <p className="au-small">Письма нет? Проверьте папку «Спам».</p>
        <div className="au__stack">
          <ResendButton left={left} busy={send.isPending} onClick={() => send.mutate()} />
          {back}
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={submit} noValidate className="au__form">
        <AuthHead title="Восстановление пароля" lead="Пришлём ссылку для сброса пароля на вашу почту" />
        <Field
          label="Почта"
          type="email"
          autoComplete="email"
          placeholder="name@mail.ru"
          value={email}
          error={error}
          onChange={(e) => {
            setEmail(e.target.value)
            setError('')
          }}
        />
        <div className="au__stack">
          <button type="submit" className="btn btn--primary au-btn" disabled={send.isPending}>
            Отправить ссылку
          </button>
          {back}
        </div>
      </form>
    </AuthShell>
  )
}

// Макет 07 · «Новый пароль» / «Пароли не совпадают» / «Пароль изменён» /
// «Ссылка устарела». Ссылку проверяем сразу при открытии.
export function ResetPasswordPage() {
  const { token } = useSearch({ from: '/reset-password' })
  const check = useQuery({
    queryKey: ['reset-token', token],
    // 204 без тела: undefined React Query считает ошибкой — возвращаем true.
    queryFn: () => api.checkResetToken(token).then(() => true),
    retry: 0,
    enabled: Boolean(token),
  })
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [errors, setErrors] = useState<{ password?: string; repeat?: string }>({})
  const [doneEmail, setDoneEmail] = useState<string | null | undefined>(undefined)
  const [expired, setExpired] = useState(false)
  const reset = useMutation({
    mutationFn: () => api.resetPassword(token, password),
    onSuccess: (r) => setDoneEmail(r.email ?? null),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'invalid_token') setExpired(true)
      else setErrors({ password: errorText(e) })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (password.length < 8) next.password = 'Пароль должен быть не короче 8 символов'
    else if (password !== repeat) next.repeat = 'Пароли не совпадают'
    setErrors(next)
    if (!next.password && !next.repeat) reset.mutate()
  }

  if (doneEmail !== undefined) {
    return (
      <AuthShell>
        <StatusIcon kind="ok" />
        <AuthHead title="Пароль изменён" lead="Теперь войдите в кабинет с новым паролем" />
        <Link to="/login" search={doneEmail ? { email: doneEmail } : {}} className="btn btn--primary au-btn">
          Войти
        </Link>
      </AuthShell>
    )
  }
  if (!token || check.isError || expired) {
    return (
      <AuthShell>
        <StatusIcon kind="error" />
        <AuthHead title="Ссылка устарела" lead="Ссылка для сброса пароля больше не действует. Запросите новую." />
        <Link to="/forgot-password" className="btn btn--primary au-btn">
          Запросить новую ссылку
        </Link>
      </AuthShell>
    )
  }
  if (check.isPending) {
    return (
      <AuthShell>
        <AuthHead title="Новый пароль" lead="Проверяем ссылку…" />
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={submit} noValidate className="au__form">
        <AuthHead title="Новый пароль" lead="Придумайте новый пароль для входа в кабинет" />
        <div className="au__fields">
          <Field
            label="Новый пароль"
            type="password"
            autoComplete="new-password"
            placeholder="Не короче 8 символов"
            value={password}
            error={errors.password}
            onChange={(e) => {
              setPassword(e.target.value)
              setErrors({})
            }}
          />
          <Field
            label="Повторите пароль"
            type="password"
            autoComplete="new-password"
            value={repeat}
            error={errors.repeat}
            onChange={(e) => {
              setRepeat(e.target.value)
              setErrors((x) => ({ ...x, repeat: undefined }))
            }}
          />
        </div>
        <button type="submit" className="btn btn--primary au-btn" disabled={reset.isPending}>
          Сохранить пароль
        </button>
      </form>
    </AuthShell>
  )
}

// Ссылка из письма «Подтвердите новую почту» (макет 09): новая почта
// становится почтой для входа, кнопка ведёт в «Настройки».
export function ConfirmEmailPage() {
  const { token } = useSearch({ from: '/confirm-email' })
  const started = useRef(false)
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>('pending')
  useEffect(() => {
    if (started.current) return
    started.current = true
    api.confirmEmailChange(token).then(
      () => setState('ok'),
      () => setState('failed'),
    )
  }, [token])

  return (
    <AuthShell>
      {state === 'pending' && <AuthHead title="Подтверждаем почту…" />}
      {state === 'ok' && (
        <>
          <StatusIcon kind="ok" />
          <AuthHead title="Почта подтверждена" lead="Теперь входите в кабинет с новой почтой." />
        </>
      )}
      {state === 'failed' && (
        <>
          <StatusIcon kind="error" />
          <AuthHead title="Ссылка устарела" lead="Ссылка из письма больше не действует. Укажите новую почту в настройках ещё раз." />
        </>
      )}
      {state !== 'pending' && (
        <Link to="/settings" className="btn btn--primary au-btn">
          Перейти в настройки
        </Link>
      )}
    </AuthShell>
  )
}
