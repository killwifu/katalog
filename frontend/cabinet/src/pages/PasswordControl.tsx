import { Link } from '@tanstack/react-router'
import { Eye, EyeOff, Lock } from 'lucide-react'
import { useState } from 'react'
import { Icon } from '../lib/icons'
import type { Plan } from '../api'

// Что продавец выбрал про пароль альбома.
// keep — оставить как есть (пароль уже стоит, и его не трогают);
// none — без пароля; set — задать новый.
export type PasswordChoice = { mode: 'keep' | 'none' | 'set'; value: string }

export const MIN_PASSWORD = 4
export const MAX_PASSWORD = 64

export function passwordError(choice: PasswordChoice): string {
  if (choice.mode !== 'set') return ''
  const n = [...choice.value].length
  if (n === 0) return 'Введите пароль или выберите «Без пароля»'
  if (n < MIN_PASSWORD) return `Пароль — не короче ${MIN_PASSWORD} символов`
  if (n > MAX_PASSWORD) return `Пароль — не длиннее ${MAX_PASSWORD} символов`
  return ''
}

// Раздел «Пароль» из макетов 10 · «Изменить доступ», 11 и 12.
//
// Пароль виден открытым текстом: продавец придумывает его, чтобы раздать
// покупателям, и должен видеть, что набрал. Прежний пароль показать
// нельзя — сервер хранит только хеш.
export function PasswordControl({
  plan,
  hasPassword,
  many,
  choice,
  onChange,
  showError,
  disabled,
}: {
  plan: Plan
  // У альбома (или хотя бы у одного из выбранных) пароль уже стоит.
  hasPassword: boolean
  many?: boolean
  choice: PasswordChoice
  onChange: (next: PasswordChoice) => void
  showError: boolean
  disabled?: boolean
}) {
  // На бесплатном тарифе пароль не задать, не сменить и не снять; тот,
  // что поставлен на платном, продолжает действовать.
  const free = plan === 'free'
  const error = showError ? passwordError(choice) : ''
  const active = choice.mode === 'keep' ? 'set' : choice.mode
  // Макет 10–12: пароль скрыт точками, «глаз» показывает набранное.
  const [shown, setShown] = useState(false)

  return (
    <div className="field">
      <span>Пароль</span>
      <div className="segbar">
        <button
          type="button"
          aria-pressed={active === 'none'}
          disabled={disabled || (free && hasPassword)}
          onClick={() => onChange({ mode: 'none', value: '' })}
        >
          Без пароля
        </button>
        <button
          type="button"
          aria-pressed={active === 'set'}
          disabled={disabled || free}
          onClick={() => onChange(hasPassword ? { mode: 'keep', value: '' } : { mode: 'set', value: '' })}
        >
          {/* Недоступно на бесплатном тарифе — с замком (макет 11 · Free). */}
          {free && <Icon as={Lock} size={14} />}
          Задать пароль
        </button>
      </div>

      {choice.mode === 'keep' && (
        <div className="pwd__saved pwdfield">
          <Icon as={Lock} />
          <span aria-label="Пароль задан">••••••</span>
          {!free && (
            <button type="button" className="pwd__change" disabled={disabled} onClick={() => onChange({ mode: 'set', value: '' })}>
              Сменить пароль
            </button>
          )}
        </div>
      )}
      {choice.mode === 'set' && (
        <div className={`pwdfield ${error ? 'pwdfield--err' : ''}`}>
          <Icon as={Lock} />
          <input
            type={shown ? 'text' : 'password'}
            value={choice.value}
            maxLength={MAX_PASSWORD}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'pwd-err' : undefined}
            aria-label="Пароль альбома"
            placeholder="Введите пароль"
            autoComplete="new-password"
            autoFocus
            onChange={(e) => onChange({ mode: 'set', value: e.target.value })}
          />
          <button
            type="button"
            className="pwdfield__eye"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
            aria-pressed={shown}
          >
            <Icon as={shown ? EyeOff : Eye} />
          </button>
        </div>
      )}
      {error && <span className="field__err" role="alert" id="pwd-err">{error}</span>}

      {free ? (
        <p className="hint hint--i">
          {/* Текст и ссылка — одним блоком: подсказка с иконкой — flex, и
              ссылка иначе уезжала отдельной колонкой. */}
          <span>
            {hasPassword
              ? 'Пароль сохранился после окончания тарифа. На бесплатном тарифе изменить или снять его нельзя. '
              : 'Пароль доступен на платных тарифах. '}
            <Link to="/billing" className="font-medium text-brand">
              {hasPassword ? 'Оплатить подписку' : 'Сменить тариф'}
            </Link>
          </span>
        </p>
      ) : choice.mode === 'none' && !hasPassword ? null : (
        // «Без пароля» у альбома без пароля ничего не меняет — в макете (11, 12)
        // подсказки под переключателем тогда нет.
        <p className={`hint ${many && choice.mode !== 'none' ? 'hint--warn' : 'hint--i'}`}>
          {choice.mode === 'none'
            ? many
              ? 'Альбомы откроются без пароля'
              : 'Альбом откроется без пароля'
            : many
              ? 'Пароль заменит текущие пароли у всех выбранных альбомов'
              : 'Покупатели введут пароль, чтобы открыть альбом'}
        </p>
      )}
    </div>
  )
}
