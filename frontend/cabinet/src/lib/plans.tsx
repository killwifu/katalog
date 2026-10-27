import { Link } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import type { Plan } from '../api'
import { Icon } from './icons'

// Названия тарифов для показа продавцу. Раньше жили только в BillingPage,
// а боковое меню и экран понижения печатали сырой enum: «тариф "free"».
export const PLAN_NAMES: Record<Plan, string> = {
  free: 'Бесплатный',
  standard: 'Стандарт',
  pro: 'Про',
  business: 'Бизнес',
}

// Порядок тарифов по возрастанию (макет 18 · «Подписка»); индекс — уровень
// тарифа, он же число закрашенных столбиков в значке.
export const PLAN_ORDER: Plan[] = ['free', 'standard', 'pro', 'business']

export const PLAN_TAGLINES: Record<Plan, string> = {
  free: 'Попробовать витрину',
  standard: 'Для небольшого каталога',
  pro: 'Для активных продаж',
  business: 'Для больших каталогов',
}

// «Сравнение тарифов» в «Подписке». Строки будут добавляться (заметка макета).
// Лимиты фото и объёма берутся из ответа сервера, здесь — возможности.
export const PLAN_FEATURES: { label: string; free: string | boolean; paid: string | boolean }[] = [
  { label: 'Пароли на альбомы', free: false, paid: true },
  { label: 'Водяной знак', free: false, paid: true },
  { label: 'Аналитика', free: false, paid: 'за 30 дней' },
]

// Значок уровня тарифа — 4 столбика, закрашены по уровню (макет 18).
export function PlanBars({ plan, size = 18 }: { plan: Plan; size?: number }) {
  const level = PLAN_ORDER.indexOf(plan) + 1
  return (
    <svg className="planbars" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={1 + i * 5}
          y={14 - i * 4}
          width="3.4"
          height={5 + i * 4}
          rx="1.2"
          fill={i < level ? 'var(--color-brand)' : 'var(--color-line)'}
        />
      ))}
    </svg>
  )
}

// Заглушка инструмента, закрытого на Бесплатном (макет 13 · «Бесплатный
// тариф», 09 · «Free-тариф»): замок, текст и «Выбрать тариф».
export function PaidLock({ text = 'Чтобы получить доступ к этому инструменту, оформите платную подписку.' }: { text?: string }) {
  return (
    <div className="paidlock">
      <span className="paidlock__ico" aria-hidden="true">
        <Icon as={Lock} size={16} />
      </span>
      <p>
        {text}
        <br />
        <Link to="/billing">Выбрать тариф</Link>
      </p>
    </div>
  )
}
