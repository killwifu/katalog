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
  id: 'free' | 'standard' | 'pro' | 'business'
  name: string
  /** ₽ в месяц; 0 — бесплатный тариф. */
  price: number
  /** ₽ за год со скидкой 25% (как в кабинете: 12 × цена × 0,75). */
  priceYear: number
  /** Подпись под ценой (макет 08: «Для небольшого каталога»). */
  tagline: string
  cta: string
  featured: boolean
  bullets: string[]
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Бесплатный',
    price: 0,
    priceYear: 0,
    tagline: 'Попробовать витрину',
    cta: 'Начать бесплатно',
    featured: false,
    bullets: ['250 фото', '1 ГБ хранилища'],
  },
  {
    id: 'standard',
    name: 'Стандарт',
    price: 390,
    priceYear: 3510,
    tagline: 'Для небольшого каталога',
    cta: 'Выбрать «Стандарт»',
    featured: false,
    bullets: ['2 000 фото', '5 ГБ хранилища', 'Пароли на альбомы', 'Аналитика за 30 дней'],
  },
  {
    id: 'pro',
    name: 'Про',
    price: 890,
    priceYear: 8010,
    tagline: 'Для активных продаж',
    cta: 'Пробный период',
    featured: true,
    bullets: ['20 000 фото', '40 ГБ хранилища', 'Пароли на альбомы', 'Аналитика за 30 дней'],
  },
  {
    id: 'business',
    name: 'Бизнес',
    price: 1690,
    priceYear: 15210,
    tagline: 'Для больших каталогов',
    cta: 'Выбрать «Бизнес»',
    featured: false,
    bullets: ['70 000 фото', '120 ГБ хранилища', 'Пароли на альбомы', 'Аналитика за 30 дней'],
  },
]

/** Значение ячейки сравнения: галочка, прочерк или текст. */
export type Cell = true | false | string

export type MatrixGroup = {
  title: string
  rows: { label: string; values: Record<Plan['id'], Cell> }[]
}

const all = (v: Cell): Record<Plan['id'], Cell> => ({ free: v, standard: v, pro: v, business: v })
const paid = (v: Cell): Record<Plan['id'], Cell> => ({ free: false, standard: v, pro: v, business: v })

// Сравнение тарифов — по макету 08 · «Лендинг · Тарифы». На Бесплатном
// закрыты пароли альбомов, водяной знак и аналитика.
export const MATRIX: MatrixGroup[] = [
  {
    title: 'Лимиты',
    rows: [
      { label: 'Фотографии', values: { free: '250', standard: '2 000', pro: '20 000', business: '70 000' } },
      { label: 'Хранилище', values: { free: '1 ГБ', standard: '5 ГБ', pro: '40 ГБ', business: '120 ГБ' } },
      { label: 'Размер одного фото', values: all('до 10 МБ') },
      { label: 'Форматы фото', values: all('JPEG, PNG, HEIC') },
      { label: 'Альбомы', values: all('Без ограничений') },
    ],
  },
  {
    title: 'Загрузка и каталог',
    rows: [
      { label: 'Массовая загрузка папками', values: all(true) },
      { label: 'Категории и подкатегории', values: all(true) },
      { label: 'Сортировка альбомов', values: all(true) },
      { label: 'Скрытие альбомов с витрины', values: all(true) },
    ],
  },
  {
    title: 'Защита фото',
    rows: [
      { label: 'Пароли на альбомы', values: paid(true) },
      { label: 'Водяной знак', values: paid(true) },
    ],
  },
  {
    title: 'Продажи и аналитика',
    rows: [
      { label: 'Кнопки «Написать» в Telegram, WhatsApp, VK, MAX и Авито', values: all(true) },
      { label: 'Аналитика посещений', values: paid('за 30 дней') },
    ],
  },
]

/** 1490 -> «1 490» (неразрывный пробел, одинаково на сервере и в браузере). */
export function formatPrice(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
