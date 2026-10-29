import { useQuery } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Eye, EyeOff, Mail } from 'lucide-react'
import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { api, type SignupIntent } from '../api'
import { intentQuery } from '../lib/signupIntent'

// Общий каркас экранов входа, регистрации, восстановления и создания
// витрины (макеты 04–08): шапка с логотипом «вуад» и ссылкой справа,
// белая карточка 440 по центру; на телефоне — карточка на всю ширину.

export function AuthShell({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="au">
      <header className="au__top">
        <a href="/" className="au__logo">вуад</a>
        {aside && <p>{aside}</p>}
      </header>
      <main className="au__body">
        <div className="au__card">{children}</div>
      </main>
    </div>
  )
}

export function AuthHead({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <div>
      <h1>{title}</h1>
      {lead && <p className="au__lead">{lead}</p>}
    </div>
  )
}

// Квадрат с иконкой над заголовком экранов-состояний (05, 07).
export function StatusIcon({ kind }: { kind: 'mail' | 'error' | 'ok' }) {
  const I = kind === 'mail' ? Mail : kind === 'error' ? CircleAlert : CircleCheck
  return (
    <span className={`au-ico au-ico--${kind}`} aria-hidden="true">
      <I size={24} strokeWidth={1.75} />
    </span>
  )
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <p className="au-msg au-msg--err" role="alert">
      <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export function FieldOk({ children }: { children: ReactNode }) {
  return (
    <p className="au-msg au-msg--ok" role="status">
      <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  // Ссылка справа от подписи («Забыли пароль?» на входе).
  aside?: ReactNode
  error?: ReactNode
  // Красная рамка без своего текста: «Неверная почта или пароль» — одна
  // ошибка на оба поля, текст под паролем.
  invalid?: boolean
  ok?: ReactNode
  hint?: ReactNode
  prefix?: string
}

// Field — поле макета: подпись 13/500, серая заливка, рамка #D92D20 и текст
// ошибки с иконкой под полем. Для type=password — «глаз».
export function Field({ label, aside, error, invalid, ok, hint, prefix, type, id, ...rest }: InputProps) {
  const [shown, setShown] = useState(false)
  const fieldId = id ?? `f-${label}`
  const isPassword = type === 'password'
  return (
    <div>
      <div className="au-field__label">
        <label htmlFor={fieldId}>{label}</label>
        {aside}
      </div>
      <div className={`au-inp${error || invalid ? ' au-inp--err' : ''}${rest.disabled ? ' au-inp--off' : ''}`}>
        {prefix && <span className="au-inp__pre">{prefix}</span>}
        <input
          id={fieldId}
          type={isPassword && shown ? 'text' : type}
          aria-invalid={Boolean(error || invalid)}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            className="au-eye"
            onClick={() => setShown((v) => !v)}
            disabled={rest.disabled}
            aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
          >
            {shown ? <Eye size={18} strokeWidth={1.5} /> : <EyeOff size={18} strokeWidth={1.5} />}
          </button>
        )}
      </div>
      {error ? <FieldError>{error}</FieldError> : ok ? <FieldOk>{ok}</FieldOk> : hint ? <p className="au-hint">{hint}</p> : null}
    </div>
  )
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/

export function useAuthOptions() {
  return useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions, staleTime: Infinity, retry: 0 })
}

// «Войти с помощью» — только провайдеры с ключами на сервере. MAX публичного
// OAuth для сайтов не даёт, его кнопки нет (см. backend/internal/api/oauth.go).
export function SocialLogin({ intent, disabled }: { intent: SignupIntent; disabled?: boolean }) {
  const options = useAuthOptions()
  const providers = options.data?.providers ?? []
  if (providers.length === 0) return null
  return (
    <div>
      <p className="au-or">Войти с помощью</p>
      <div className="au-social">
        {providers.map((p) => (
          <a
            key={p}
            href={`/api/v1/auth/oauth/${p}/start${intentQuery(intent)}`}
            aria-label={p === 'yandex' ? 'Войти через Яндекс' : 'Войти через VK'}
            aria-disabled={disabled}
            className={disabled ? 'is-off' : undefined}
          >
            {p === 'yandex' ? <YandexLogo /> : <VKLogo />}
          </a>
        ))}
      </div>
    </div>
  )
}

function YandexLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#FC3F1D" />
      <text x="12" y="17" textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">Я</text>
    </svg>
  )
}

function VKLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0077FF" />
      <text x="12" y="15.6" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">VK</text>
    </svg>
  )
}

// useCooldown — «Отправить ещё раз через 0:59» (макеты 05, 07): секунды до
// повторной отправки и перезапуск отсчёта.
export function useCooldown(initial: number): [number, () => void] {
  const [until, setUntil] = useState(() => Date.now() + initial * 1000)
  const [now, setNow] = useState(() => Date.now())
  const left = Math.max(0, Math.ceil((until - now) / 1000))
  useEffect(() => {
    if (left <= 0) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [left])
  return [left, () => {
    setUntil(Date.now() + 60_000)
    setNow(Date.now())
  }]
}

export function ResendButton({ left, busy, onClick, label = 'Отправить письмо ещё раз' }: { left: number; busy?: boolean; onClick: () => void; label?: string }) {
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return (
    <button type="button" className="btn btn--ghost au-btn" disabled={left > 0 || busy} onClick={onClick}>
      {left > 0 ? `Отправить ещё раз через ${mmss}` : label}
    </button>
  )
}
