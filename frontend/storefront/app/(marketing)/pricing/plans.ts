// Тарифы и матрица сравнения — один источник данных для трёх представлений:
// карточек, таблицы на десктопе и переключателя панелей на мобильном.
// Цены отсюда же показывает главная.
//
// ВАЖНО: цифры здесь должны совпадать с тем, что система реально считает и
// списывает — backend/internal/config/config.go, блок Billing.Plans. Это
// проверяет scripts/check-plans.mjs в CI: разошлись — сборка падает.
// Идентификаторы тарифов те же, что в базе (shops.plan), чтобы карточка
// на сайте и строка в кабинете не могли разъехаться незаметно.

export type Plan = {
  id: 'free' | 'basic' | 'pro'
  name: string
  /** ₽ в месяц; 0 — бесплатный тариф. */
  price: number
  cta: string
  featured: boolean
  bullets: string[]
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Бесплатный',
    price: 0,
    cta: 'Начать',
    featured: false,
    bullets: ['500 фото', '1 ГБ хранилища', 'Все возможности витрины', 'Без карты и без срока'],
  },
  {
    id: 'basic',
    name: 'Базовый',
    price: 490,
    cta: 'Выбрать',
    featured: true,
    bullets: [
      '5 000 фото',
      '10 ГБ хранилища',
      'Все возможности витрины',
      'Оплата картой или через СБП',
    ],
  },
  {
    id: 'pro',
    name: 'Про',
    price: 990,
    cta: 'Выбрать',
    featured: false,
    bullets: [
      '20 000 фото',
      '20 ГБ хранилища',
      'Все возможности витрины',
      'Оплата картой или через СБП',
    ],
  },
]

/** Значение ячейки сравнения: галочка, прочерк или текст. */
export type Cell = true | false | string

export type MatrixGroup = {
  title: string
  rows: { label: string; values: Record<Plan['id'], Cell> }[]
}

// Тарифы различаются только объёмом — возможности одинаковые на всех.
// Строки, одинаковые во всех колонках, страница приглушает сама.
export const MATRIX: MatrixGroup[] = [
  {
    title: 'Объём',
    rows: [
      { label: 'Фотографии', values: { free: '500', basic: '5 000', pro: '20 000' } },
      { label: 'Хранилище', values: { free: '1 ГБ', basic: '10 ГБ', pro: '20 ГБ' } },
      { label: 'Альбомы', values: { free: 'до 1 000', basic: 'до 1 000', pro: 'до 1 000' } },
      {
        label: 'Просмотры витрины',
        values: { free: 'не ограничены', basic: 'не ограничены', pro: 'не ограничены' },
      },
    ],
  },
  {
    title: 'Витрина',
    rows: [
      { label: 'Альбомы и категории, 2 уровня', values: { free: true, basic: true, pro: true } },
      { label: 'Свои вкладки и разделы', values: { free: true, basic: true, pro: true } },
      { label: 'Поиск по подписям', values: { free: true, basic: true, pro: true } },
      { label: 'Переход в мессенджер продавца', values: { free: true, basic: true, pro: true } },
      { label: 'Скрытые альбомы', values: { free: true, basic: true, pro: true } },
    ],
  },
  {
    title: 'Работа с фото',
    rows: [
      { label: 'Массовая загрузка с телефона', values: { free: true, basic: true, pro: true } },
      { label: 'Водяной знак', values: { free: true, basic: true, pro: true } },
    ],
  },
  {
    title: 'Дополнительно',
    rows: [
      {
        label: 'Статистика: просмотры, посетители, переходы',
        values: { free: true, basic: true, pro: true },
      },
    ],
  },
]

/** 1490 -> «1 490» (неразрывный пробел, одинаково на сервере и в браузере). */
export function formatPrice(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
