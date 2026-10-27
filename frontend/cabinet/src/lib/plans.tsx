import type { Plan } from '../api'

// Названия тарифов для показа продавцу. Раньше жили только в BillingPage,
// а боковое меню и экран понижения печатали сырой enum: «тариф "free"».
export const PLAN_NAMES: Record<Plan, string> = {
  free: 'Бесплатный',
  basic: 'Базовый',
  pro: 'Про',
}
