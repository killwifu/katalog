import { Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Gift, Info } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, errorText, type SignupIntent } from '../api'
import { takeFlash } from '../lib/flash'
import { PLAN_NAMES } from '../lib/plans'
import { clearIntent, readIntent } from '../lib/signupIntent'
import { AuthHead, AuthShell, EMAIL_RE, Field, SocialLogin, useAuthOptions } from './AuthShell'

// Поля регистрации, к которым возвращает «Изменить почту» на экране
// «Подтвердите почту» (макет 05). Только в памяти вкладки: пароль не пишем
// ни в какое хранилище.
let draft: { email: string; password: string } | null = null
export function setRegistrationDraft(d: { email: string; password: string }) {
  // С экрана «Подтвердите почту» пароль не известен — сохраняем тот, что
  // остался от регистрации в этой вкладке.
  draft = draft && draft.email === d.email && !d.password ? draft : d
}

const LOCK_TEXT = 'Слишком много попыток входа. Попробуйте снова через 15 минут или восстановите пароль.'

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  return mode === 'register' ? <RegisterPage /> : <LoginPage />
}

// Макет 04 · «Регистрация».
function RegisterPage() {
  const navigate = useNavigate()
  const [initial] = useState(() => {
    const d = draft
    draft = null
    return d
  })
  const [email, setEmail] = useState(initial?.email ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [errors, setErrors] = useState<{ email?: ReactNode; password?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  // Обычная регистрация (без тарифа в адресе) — на Бесплатном: тариф,
  // запомненный с прошлого визита на лендинг, не подхватываем.
  const [intent] = useState(() => {
    if (!/[?&](plan|trial)=/.test(location.search)) clearIntent()
    return readIntent()
  })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    // Поля проверяются по нажатию «Создать аккаунт» (заметка макета).
    const next: typeof errors = {}
    if (!EMAIL_RE.test(email.trim())) next.email = 'Проверьте адрес почты — похоже, в нём ошибка'
    if (password.length < 8) next.password = 'Пароль должен быть не короче 8 символов'
    setErrors(next)
    if (next.email || next.password) return
    setBusy(true)
    try {
      await api.register(email.trim(), password, intent)
      setRegistrationDraft({ email: email.trim(), password })
      void navigate({ to: '/check-email' })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      if (code === 'email_taken') {
        setErrors({
          email: (
            <>
              Эта почта уже зарегистрирована.{' '}
              <Link to="/login" search={{ email: email.trim() }} className="lnk">
                Войти
              </Link>
            </>
          ),
        })
      } else if (code === 'invalid_email') setErrors({ email: 'Проверьте адрес почты — похоже, в нём ошибка' })
      else if (code === 'weak_password' || code === 'password_too_long') setErrors({ password: errorText(err) })
      else setErrors({ form: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      aside={
        <>
          Уже есть аккаунт? <Link to="/login" className="lnk">Войти</Link>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="au__form">
        <AuthHead title="Создание аккаунта" lead="Почта и пароль нужны для входа в кабинет" />
        <PlanNote intent={intent} />
        {errors.form && <Alert>{errors.form}</Alert>}
        <div className="au__fields">
          <Field
            label="Почта"
            type="email"
            autoComplete="email"
            placeholder="name@mail.ru"
            value={email}
            error={errors.email}
            onChange={(e) => {
              setEmail(e.target.value)
              setErrors((x) => ({ ...x, email: undefined }))
            }}
          />
          <Field
            label="Пароль"
            type="password"
            autoComplete="new-password"
            placeholder="Не короче 8 символов"
            value={password}
            error={errors.password}
            onChange={(e) => {
              setPassword(e.target.value)
              setErrors((x) => ({ ...x, password: undefined }))
            }}
          />
        </div>
        <button type="submit" className="btn btn--primary au-btn" disabled={busy}>
          Создать аккаунт
        </button>
        <SocialLogin intent={intent} />
        <p className="au-legal">
          Нажимая «Создать аккаунт», вы принимаете условия{' '}
          <a href="/terms" target="_blank" rel="noopener" className="lnk">оферты</a> и{' '}
          <a href="/privacy" target="_blank" rel="noopener" className="lnk">политики конфиденциальности</a>
        </p>
      </form>
    </AuthShell>
  )
}

// Плашка выбранного тарифа (макет 04 · «Пробный период «Про»» и «Выбран тариф»).
function PlanNote({ intent }: { intent: SignupIntent }) {
  const options = useAuthOptions()
  if (intent.trial) {
    return (
      <div className="au-note">
        <i aria-hidden="true"><Gift size={18} strokeWidth={1.5} /></i>
        <p>
          <b>7 дней тарифа «Про» бесплатно</b>
          <span>Без привязки карты</span>
        </p>
      </div>
    )
  }
  if (!intent.plan) return null
  const year = intent.period === 'year'
  const kop = options.data?.prices[intent.plan]?.[year ? 'year' : 'month']
  const price = kop ? ` — ${(kop / 100).toLocaleString('ru-RU')} ₽ ${year ? 'в год' : 'в месяц'}` : ''
  return (
    <div className="au-note">
      <i aria-hidden="true"><Info size={18} strokeWidth={1.5} /></i>
      <p>
        <b>Тариф «{PLAN_NAMES[intent.plan]}»{price}</b>
        <span>Оплата — после создания витрины</span>
      </p>
    </div>
  )
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="au-alert" role="alert">
      <CircleAlert size={16} strokeWidth={2} aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

// Макет 06 · «Вход».
function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = new URLSearchParams(location.search)
  const [email, setEmail] = useState(search.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState(false)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState(search.get('oauth_error') ? 'Не удалось войти через внешний сервис — попробуйте ещё раз' : '')
  const [busy, setBusy] = useState(false)
  const [notice] = useState(() => takeFlash()?.text ?? '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setWrong(false)
    setBusy(true)
    try {
      const user = await api.login(email.trim(), password)
      queryClient.clear()
      if (!user.email_verified) {
        // Почта не подтверждена — экран 05 (письмо сервер уже отправил).
        void navigate({ to: '/check-email' })
        return
      }
      // Вернуть туда, откуда отправили на вход (см. redirectSearch в main.tsx).
      const back = search.get('redirect')
      if (back && back.startsWith('/') && !back.startsWith('//')) void navigate({ href: back })
      else void navigate({ to: '/' })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      if (code === 'invalid_credentials') setWrong(true)
      else if (code === 'login_locked') setLocked(true)
      else setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      aside={
        <>
          Нет аккаунта? <Link to="/register" className="lnk">Создать</Link>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="au__form">
        <AuthHead title="Вход в кабинет" />
        {locked && <Alert>{LOCK_TEXT}</Alert>}
        {error && !locked && <Alert>{error}</Alert>}
        {notice && !error && !locked && <p className="au-msg au-msg--ok" role="status">{notice}</p>}
        <div className="au__fields">
          <Field
            label="Почта"
            type="email"
            autoComplete="email"
            placeholder="name@mail.ru"
            value={email}
            invalid={wrong}
            disabled={locked}
            required
            onChange={(e) => {
              setEmail(e.target.value)
              setWrong(false)
            }}
          />
          {/* Одна ошибка на оба поля — чтобы не подсказывать, есть ли такая почта. */}
          <Field
            label="Пароль"
            type="password"
            autoComplete="current-password"
            placeholder="Ваш пароль"
            value={password}
            error={wrong ? 'Неверная почта или пароль' : undefined}
            disabled={locked}
            required
            aside={<Link to="/forgot-password" className="lnk au-field__aside">Забыли пароль?</Link>}
            onChange={(e) => {
              setPassword(e.target.value)
              setWrong(false)
            }}
          />
        </div>
        <button type="submit" className="btn btn--primary au-btn" disabled={busy || locked}>
          Войти
        </button>
        <SocialLogin intent={readIntent()} />
      </form>
    </AuthShell>
  )
}
