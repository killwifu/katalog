// Тарифы и матрица сравнения — один источник данных для трёх представлений:
// карточек, таблицы на десктопе и переключателя панелей на мобильном.
// Цены отсюда же показывает главная.

export type Plan = {
  id: 'start' | 'basic' | 'sell' | 'biz'
  name: string
  /** ₽ в месяц при помесячной оплате; 0 — бесплатный тариф. */
  price: number
  /** ₽ за год (−25%); null у бесплатного. */
  yearPrice: number | null
  cta: string
  featured: boolean
  bullets: string[]
}

export const PLANS: Plan[] = [
  {
    id: 'start',
    name: 'Старт',
    price: 0,
    yearPrice: null,
    cta: 'Начать',
    featured: false,
    bullets: ['100 фото, 10 альбомов', '1 ГБ хранилища', '4 базовые вкладки', '10 удалений фона в месяц'],
  },
  {
    id: 'basic',
    name: 'Базовый',
    price: 290,
    yearPrice: 2610,
    cta: 'Попробовать 14 дней',
    featured: false,
    bullets: [
      '500 фото, 50 альбомов',
      '3 ГБ хранилища',
      'Свои вкладки и разделы',
      'Водяной знак',
      'Без плашки сервиса',
    ],
  },
  {
    id: 'sell',
    name: 'Продавец',
    price: 590,
    yearPrice: 5310,
    cta: 'Попробовать 14 дней',
    featured: true,
    bullets: [
      '5 000 фото, альбомы без счёта',
      '20 ГБ хранилища',
      'Скрытые и парольные альбомы',
      '300 удалений фона в месяц',
      'Статистика с источниками',
    ],
  },
  {
    id: 'biz',
    name: 'Бизнес',
    price: 1490,
    yearPrice: 13410,
    cta: 'Попробовать 14 дней',
    featured: false,
    bullets: [
      '30 000 фото',
      '100 ГБ хранилища',
      'Свой домен',
      'До 5 сотрудников',
      'Приоритетная поддержка',
    ],
  },
]

/** Значение ячейки сравнения: галочка, прочерк или текст. */
export type Cell = true | false | string

export type MatrixGroup = {
  title: string
  rows: { label: string; values: Record<Plan['id'], Cell> }[]
}

export const MATRIX: MatrixGroup[] = [
  {
    title: 'Объём',
    rows: [
      { label: 'Фотографии', values: { start: '100', basic: '500', sell: '5 000', biz: '30 000' } },
      { label: 'Альбомы', values: { start: '10', basic: '50', sell: 'без счёта', biz: 'без счёта' } },
      { label: 'Хранилище', values: { start: '1 ГБ', basic: '3 ГБ', sell: '20 ГБ', biz: '100 ГБ' } },
      {
        label: 'Просмотры витрины',
        values: {
          start: 'не ограничены',
          basic: 'не ограничены',
          sell: 'не ограничены',
          biz: 'не ограничены',
        },
      },
    ],
  },
  {
    title: 'Витрина',
    rows: [
      { label: 'Базовые вкладки', values: { start: true, basic: true, sell: true, biz: true } },
      { label: 'Свои вкладки и разделы', values: { start: false, basic: true, sell: true, biz: true } },
      { label: 'Категории', values: { start: '1 уровень', basic: '2 уровня', sell: '2 уровня', biz: '2 уровня' } },
      { label: 'Фирменный цвет и обложка', values: { start: false, basic: true, sell: true, biz: true } },
      { label: 'Плашка сервиса', values: { start: 'есть', basic: 'убирается', sell: 'убирается', biz: 'убирается' } },
      {
        label: 'Адрес витрины',
        values: { start: 'наш домен', basic: 'наш домен', sell: 'наш домен', biz: 'свой домен' },
      },
      { label: 'Скрытые и парольные альбомы', values: { start: false, basic: false, sell: true, biz: true } },
    ],
  },
  {
    title: 'Работа с фото',
    rows: [
      { label: 'Водяной знак', values: { start: false, basic: 'ник', sell: 'ник', biz: 'ник или логотип' } },
      { label: 'Удаление фона', values: { start: '10 / мес', basic: '50 / мес', sell: '300 / мес', biz: '1 500 / мес' } },
    ],
  },
  {
    title: 'Дополнительно',
    rows: [
      {
        label: 'Статистика',
        values: { start: '7 дней', basic: '30 дней', sell: '90 дней, источники', biz: '12 месяцев' },
      },
      { label: 'Сотрудники', values: { start: false, basic: false, sell: false, biz: 'до 5' } },
      { label: 'Поддержка', values: { start: 'почта', basic: 'почта', sell: 'чат', biz: 'приоритет' } },
    ],
  },
]

/** 1490 -> «1 490» (неразрывный пробел, одинаково на сервере и в браузере). */
export function formatPrice(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
