// Типизированный клиент REST API /api/v1 (контракт: api/openapi.yaml).
const API = '/api/v1'

// Человеческие тексты для машинных кодов бэкенда. Сообщения самого API
// приходят по-английски: показывать их продавцу нельзя, кабинет русский.
export const API_ERRORS: Record<string, string> = {
  slug_taken: 'Этот адрес уже занят',
  invalid_slug: 'Адрес: 3–63 символа, латиница, цифры и одиночные дефисы',
  slug_reserved: 'Этот адрес занят служебными страницами сервиса — придумайте другой',
  invalid_contacts: 'Проверьте контакты: ник латиницей или ссылка на сам мессенджер',
  invalid_telegram: 'Telegram: ник из латиницы, цифр и _ или ссылка вида t.me/ник',
  invalid_whatsapp: 'WhatsApp: номер в международном формате, только цифры — например 79991234567',
  invalid_name: 'Укажите название',
  invalid_title: 'Укажите название (до 200 символов)',
  invalid_parent: 'Неверная родительская категория',
  too_deep: 'Больше двух уровней вложенности нельзя',
  slug_change_too_soon: 'Адрес можно менять не чаще раза в полгода',
  invalid_status: 'Неизвестный статус',
  invalid_description: 'Описание слишком длинное',
  photo_quota_exceeded: 'Достигнут лимит фотографий на тарифе',
  quota_exceeded: 'Закончилось место в хранилище',
  album_limit: 'Достигнут предел числа альбомов',
  album_empty: 'В альбоме нет готовых фото',
  invalid_password: 'Пароль: от 4 до 64 символов',
  password_plan_required: 'На бесплатном тарифе пароль на альбом недоступен',
  watermark_plan_required: 'Водяной знак доступен на платных тарифах',
  analytics_plan_required: 'Аналитика доступна на платных тарифах',
  trial_unavailable: 'Пробный период уже использован',
  resume_unavailable: 'Автопродление не включить: нет сохранённой карты — оплатите тариф заново',
  not_found: 'Не найдено',
  billing_unavailable: 'Оплата тарифов пока недоступна — платёжный провайдер не подключён',
  payment_provider_error: 'Платёжный сервис не ответил. Попробуйте через несколько минут',
  invalid_caption: 'Подпись слишком длинная — не больше 2000 символов',
  invalid_settings: 'Проверьте настройки: какое-то значение вне допустимого',
  invalid_cover: 'Обложкой можно сделать только фото из этого альбома',
  too_many_tabs: 'Слишком много вкладок для сортировки',
  too_many_albums: 'В разделе не больше 500 альбомов',
  shop_suspended: 'Магазин заблокирован модератором — загрузка недоступна',
  shop_limit: 'На один аккаунт — не больше 5 магазинов',
  invalid_token: 'Ссылка недействительна или устарела',
  rate_limited: 'Слишком много запросов — подождите минуту',
  internal: 'Ошибка на сервере. Попробуйте ещё раз чуть позже',
  wrong_password: 'Неверный пароль',
  weak_password: 'Пароль — не короче 8 символов',
}

// errorText — текст для показа продавцу. Незнакомый код лучше показать
// как есть, чем проглотить: иначе диагностировать станет нечем.
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return API_ERRORS[e.code] ?? e.message
  // fetch без сети падает TypeError — по-английски и без подсказки, что
  // делать. Тексты у браузеров свои: Chrome, Firefox, Safari.
  if (e instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(e.message)) return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз'
  return e instanceof Error ? e.message : 'Что-то пошло не так'
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  // Сессия могла кончиться на уже открытой странице: beforeLoad маршрута
  // отрабатывает только при переходе, а запросы после этого возвращают 401
  // и продавец остаётся на экране «Не удалось загрузить данные», не понимая,
  // что его просто разлогинило. Формы входа это не касается — там 401
  // означает неверный пароль.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Подсказка «сессия есть» не httpOnly и живёт своим сроком: без
    // сброса публичные страницы продолжат звать в кабинет.
    document.cookie = 'katalog_signed=; Path=/; Max-Age=0'
    const here = location.pathname.replace(/^\/app/, '') + location.search
    location.assign(here && here !== '/' ? `/app/login?redirect=${encodeURIComponent(here)}` : '/app/login')
  }
  if (res.status === 204) return undefined as T
  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = data as { error?: string; message?: string }
    throw new ApiError(res.status, err.error ?? 'unknown', err.message ?? res.statusText)
  }
  return data as T
}

export type User = {
  id: string
  email: string | null
  role: 'user' | 'admin'
  email_verified: boolean
}

export type AdminComplaint = {
  id: string
  shop_id: string | null
  shop_slug: string | null
  photo_id: string | null
  photo_album_id: string | null
  reason: string
  reporter_name: string
  reporter_email: string
  content_url: string
  status: 'open' | 'in_review' | 'resolved' | 'rejected'
  created_at: string
  resolved_at: string | null
}

export type FlaggedPhoto = {
  id: string
  shop_id: string
  shop_slug: string
  album_id: string
  caption: string
  status: PhotoStatus
  // Код причины отказа обработки; пусто, если фото не в статусе failed.
  fail_reason?: string
}

export type Plan = 'free' | 'standard' | 'pro' | 'business'
export type BillingPeriod = 'month' | 'year'
export type BillingState = 'ok' | 'grace' | 'suspended'

export type Shop = {
  id: string
  slug: string
  name: string
  description: string
  plan: Plan
  // Блокировка модератором. Продавец её не снимает, но должен понимать,
  // почему витрина недоступна и почему не грузятся фотографии.
  status: 'active' | 'suspended' | 'deleted'
  billing_state: BillingState
  paid_until: string | null
  storage_used: number
  storage_max: number
  max_photos: number
  contacts: ShopContacts
  settings: ShopSettings
  // Когда адрес можно будет сменить снова; null — можно сейчас.
  // Срок считает сервер: повторять правило здесь значит разойтись с ним.
  slug_changeable_at: string | null
}

// Каналы связи продавца. Ключи совпадают с теми, что читает витрина
// (storefront/lib/links.ts) — расхождение здесь молча ломает кнопки.
export type ShopContacts = {
  telegram?: string
  whatsapp?: string
  vk?: string
  max?: string
}

export type ShopSettings = {
  msg_template?: string
  // Показывается рядом с кнопкой «Написать»: помогает покупателю
  // не ждать ответа ночью.
  reply_time?: string
  watermark?: { enabled: boolean; text: string; opacity: number; position?: WatermarkPosition }
}

// Клетки сетки 3×3 через запятую («tl,br») или «tile» — см. lib/watermark.ts.
export type WatermarkPosition = string

export type AdminShop = {
  id: string
  slug: string
  name: string
  email: string
  plan: Plan
  status: string
  billing_state: BillingState
  storage_used: number
  photos: number
  complaints: number
}

export type PlanInfo = {
  id: Plan
  max_photos: number
  max_storage: number
  price_rub: number
  // За год со скидкой 25%.
  price_year_rub: number
}

export type Billing = {
  plan: Plan
  billing_state: BillingState
  paid_until: string | null
  // Пробный «Про»: когда кончится (кончился); null — не брали.
  trial_ends_at: string | null
  trial_available: boolean
  usage: { photos: number; storage_used: number; trash_photos: number; trash_bytes: number }
  limits: PlanInfo
  subscription: {
    plan: Plan
    status: 'active' | 'past_due' | 'canceled' | 'expired'
    period: BillingPeriod
    period_end: string
    auto_renew: boolean
    // Переход ниже, запланированный на конец периода.
    next_plan: Plan | null
    next_period: BillingPeriod | null
  } | null
  plans: PlanInfo[]
  // Последняя оплата не прошла — плашка «Оплата не прошла».
  failed_payment: { plan: Plan; period: BillingPeriod } | null
}

// Что произойдёт при выборе тарифа: оплата (с суммой), переход ниже
// с конца периода или это уже текущий тариф. Считает сервер.
export type BillingQuote = {
  action: 'pay' | 'schedule' | 'current'
  kind?: 'period' | 'upgrade' | 'switch'
  plan: Plan
  period: BillingPeriod
  from_plan?: Plan
  amount_rub: number
  days: number
  period_end: string
}

export type Payment = {
  id: string
  created_at: string
  plan: Plan
  from_plan: Plan | null
  kind: 'period' | 'upgrade' | 'switch'
  period: BillingPeriod
  amount_rub: number
  status: 'succeeded' | 'canceled'
  recurring: boolean
  period_start: string | null
  period_end: string | null
}

// Свой знак альбома; null — как у магазина (settings.watermark).
export type AlbumWatermark = { enabled: boolean; position: WatermarkPosition }

export type Album = {
  watermark: AlbumWatermark | null
  id: string
  parent_id: string | null
  title: string
  cover_photo_id: string | null
  sort_order: number
  status: AlbumStatus
  // Блокировка модератором по жалобе: снять её продавец не может,
  // но должен понимать, почему альбома нет на витрине.
  blocked_by_moderator: boolean
  description: string
  category_id: string | null
  // Все категории альбома (он может лежать в нескольких); category_id —
  // первая из них.
  category_ids: string[]
  // Место альбома в каждой из его категорий (id категории → номер).
  category_pos?: Record<string, number>
  photo_count: number
  // Альбом закрыт паролем. Сам пароль сервер не отдаёт — только задаёт.
  has_password: boolean
  // Обложку собирает сервер: базовый префикс медиа кабинету неизвестен.
  cover_urls?: { small: string; medium: string; large: string }
  created_at: string
  updated_at: string
}

export type Category = {
  id: string
  parent_id: string | null
  title: string
  slug: string
  sort_order: number
  // Скрыта с витрины: покупатель не видит её ни в меню, ни по адресу.
  is_hidden: boolean
  // Показывается блоком на главной странице витрины.
  on_home: boolean
}

export type AlbumStatus = 'published' | 'unlisted' | 'draft'

export type Tab = {
  id: string
  title: string
  slug: string
  is_system: boolean
  sort_order: number
}

export type Section = {
  id: string
  tab_id: string
  title: string
  sort_order: number
  album_ids: string[]
}

export type PhotoStatus = 'uploading' | 'processing' | 'ready' | 'failed' | 'blocked'

export type Photo = {
  id: string
  album_id: string
  caption: string
  status: PhotoStatus
  width: number
  height: number
  sort_order: number
  urls?: { small: string; medium: string; large: string }
  // Код причины отказа обработки; приходит только при status = failed.
  fail_reason?: string
}

export type PhotoPage = {
  photos: Photo[]
  page: number
  per_page: number
  total: number
}

// Удалённый альбом в корзине: одной строкой вместе со своими фото.
export type TrashAlbum = {
  id: string
  title: string
  photo_count: number
  deleted_at: string
  cover_urls?: { small: string; medium: string; large: string }
}

export type TrashPage = {
  // Альбомы приходят только на первой странице.
  albums: TrashAlbum[]
  photos: Photo[]
  total: number
  page: number
  per_page: number
  // Сколько дней фотография лежит в корзине до окончательной уборки.
  keep_days: number
}

export type ConfirmResult = { photo_id: string; status: string; error?: string; code?: string }

export type ShopStats = {
  days: number
  totals: { views: number; unique_visitors: number; lead_clicks: number }
  daily: { date: string; views: number; unique_visitors: number; lead_clicks: number }[]
  channels: { channel: string; clicks: number }[]
  // Сколько разных альбомов открывали за последние 7 дней.
  albums_viewed_week?: number
  top_albums: { album_id: string; title: string; views: number }[]
  top_photos: { photo_id: string; caption: string; clicks: number; thumb_url?: string }[]
}

export const api = {
  register: (email: string, password: string) =>
    request<User>('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) =>
    request<User>('POST', '/auth/login', { email, password }),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<User>('GET', '/auth/me'),
  forgotPassword: (email: string) =>
    request<void>('POST', '/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) =>
    request<void>('POST', '/auth/password/reset', { token, password }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('POST', '/auth/password/change', {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  verifyEmail: (token: string) => request<void>('POST', '/auth/verify-email', { token }),

  listShops: () => request<Shop[]>('GET', '/shops'),
  createShop: (slug: string, name: string) => request<Shop>('POST', '/shops', { slug, name }),
  getShop: (shopId: string) => request<Shop>('GET', `/shops/${shopId}`),
  updateShop: (shopId: string, patch: { name?: string; description?: string; slug?: string }) =>
    request<Shop>('PATCH', `/shops/${shopId}`, patch),
  updateContacts: (shopId: string, contacts: ShopContacts) =>
    request<Shop>('PATCH', `/shops/${shopId}`, { contacts }),
  updateSettings: (shopId: string, settings: ShopSettings) =>
    request<Shop>('PATCH', `/shops/${shopId}`, { settings }),

  listAlbums: (shopId: string) => request<Album[]>('GET', `/shops/${shopId}/albums`),
  updateAlbum: (
    shopId: string,
    albumId: string,
    // password: непустая строка задаёт пароль, пустая — снимает.
    patch: { title?: string; description?: string; cover_photo_id?: string; password?: string; watermark?: AlbumWatermark | null },
  ) =>
    request<Album>('PATCH', `/shops/${shopId}/albums/${albumId}`, patch),
  setAlbumStatus: (shopId: string, albumId: string, status: AlbumStatus) =>
    request<Album>('PATCH', `/shops/${shopId}/albums/${albumId}`, { status }),
  createAlbum: (shopId: string, title: string, parentId?: string, watermark?: AlbumWatermark) =>
    request<Album>('POST', `/shops/${shopId}/albums`, {
      title,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(watermark ? { watermark } : {}),
    }),
  // Страницами: альбом может содержать тысячи фото, выдача целиком
  // вешала кабинет.
  // Корзина: удаление обратимо, пока ночная уборка не вынесет фото по сроку.
  listTrash: (shopId: string, page = 1) =>
    request<TrashPage>('GET', `/shops/${shopId}/trash?page=${page}`),
  restorePhoto: (shopId: string, photoId: string) =>
    request<Photo>('POST', `/shops/${shopId}/trash/${photoId}/restore`),
  purgePhoto: (shopId: string, photoId: string) =>
    request<void>('DELETE', `/shops/${shopId}/trash/${photoId}`),
  emptyTrash: (shopId: string) => request<void>('DELETE', `/shops/${shopId}/trash`),
  restoreAlbum: (shopId: string, albumId: string) =>
    request<Album>('POST', `/shops/${shopId}/trash/albums/${albumId}/restore`),
  purgeAlbum: (shopId: string, albumId: string) =>
    request<void>('DELETE', `/shops/${shopId}/trash/albums/${albumId}`),
  listPhotos: (shopId: string, albumId: string, page = 1) =>
    request<PhotoPage>('GET', `/shops/${shopId}/albums/${albumId}/photos?page=${page}`),

  // Показатели альбома за 7 дней для его страницы.
  getAlbumStats: (shopId: string, albumId: string) =>
    request<{ views_week: number; views_prev_week: number; lead_clicks: number }>(
      'GET',
      `/shops/${shopId}/albums/${albumId}/stats`,
    ),
  // Архив оригиналов альбома. check — сводка без самого архива: по ней
  // кабинет понимает, что скачивать есть что, до начала загрузки.
  checkAlbumDownload: (shopId: string, albumId: string, ids?: string[]) =>
    request<{ photos: number; bytes: number }>(
      'GET',
      `/shops/${shopId}/albums/${albumId}/download?check=1${ids?.length ? `&ids=${ids.join(',')}` : ''}`,
    ),
  albumDownloadUrl: (shopId: string, albumId: string, ids?: string[]) =>
    `${API}/shops/${shopId}/albums/${albumId}/download${ids?.length ? `?ids=${ids.join(',')}` : ''}`,

  // Порядок фото на странице альбома задаётся целиком, как у вкладок.
  setPhotoOrder: (shopId: string, albumId: string, photoIds: string[]) =>
    request<void>('PUT', `/shops/${shopId}/albums/${albumId}/photos/order`, { photo_ids: photoIds }),

  listTabs: (shopId: string) => request<Tab[]>('GET', `/shops/${shopId}/tabs`),
  createTab: (shopId: string, title: string, slug: string) =>
    request<Tab>('POST', `/shops/${shopId}/tabs`, { title, slug }),
  // Порядок задаётся целиком: обмен двумя PATCH рвался посередине и
  // оставлял у соседних вкладок одинаковый sort_order.
  setTabOrder: (shopId: string, tabIds: string[]) =>
    request<void>('PUT', `/shops/${shopId}/tabs/order`, { tab_ids: tabIds }),
  deleteTab: (shopId: string, tabId: string) =>
    request<void>('DELETE', `/shops/${shopId}/tabs/${tabId}`),

  listSections: (shopId: string) => request<Section[]>('GET', `/shops/${shopId}/sections`),
  createSection: (shopId: string, tabId: string, title: string) =>
    request<Section>('POST', `/shops/${shopId}/tabs/${tabId}/sections`, { title }),
  updateSection: (shopId: string, sectionId: string, title: string, sortOrder: number) =>
    request<Section>('PATCH', `/shops/${shopId}/sections/${sectionId}`, { title, sort_order: sortOrder }),
  deleteSection: (shopId: string, sectionId: string) =>
    request<void>('DELETE', `/shops/${shopId}/sections/${sectionId}`),
  // Состав секции задаётся целиком: порядок в массиве — порядок на витрине.
  setSectionAlbums: (shopId: string, sectionId: string, albumIds: string[]) =>
    request<void>('PUT', `/shops/${shopId}/sections/${sectionId}/albums`, { album_ids: albumIds }),

  listCategories: (shopId: string) =>
    request<Category[]>('GET', `/shops/${shopId}/categories`),
  createCategory: (shopId: string, title: string, slug: string, parentId?: string) =>
    request<Category>('POST', `/shops/${shopId}/categories`, {
      title,
      slug,
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  // parentId: null — вынести на верхний уровень, undefined — не трогать
  // (сервер трактует отсутствующее поле как «без родителя», поэтому шлём
  // текущее значение явно).
  updateCategory: (
    shopId: string,
    id: string,
    title: string,
    slug: string,
    parentId: string | null = null,
    // Не передан — сервер оставляет категорию на её месте.
    sortOrder?: number,
  ) =>
    request<Category>('PATCH', `/shops/${shopId}/categories/${id}`, {
      title,
      slug,
      ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  // Альбом можно положить в несколько категорий: добавление не трогает
  // остальные, удаление убирает только из этой.
  addAlbumToCategory: (shopId: string, categoryId: string, albumId: string) =>
    request<void>('PUT', `/shops/${shopId}/categories/${categoryId}/albums/${albumId}`),
  // Порядок альбомов внутри категории — он же порядок на витрине.
  setCategoryAlbumOrder: (shopId: string, categoryId: string, albumIds: string[]) =>
    request<void>('PUT', `/shops/${shopId}/categories/${categoryId}/albums/order`, { album_ids: albumIds }),
  removeAlbumFromCategory: (shopId: string, categoryId: string, albumId: string) =>
    request<void>('DELETE', `/shops/${shopId}/categories/${categoryId}/albums/${albumId}`),
  setCategoryVisibility: (shopId: string, id: string, patch: { is_hidden?: boolean; on_home?: boolean }) =>
    request<Category>('PATCH', `/shops/${shopId}/categories/${id}/visibility`, patch),
  // moveTo пустой — альбомы останутся без категории, но не удалятся.
  deleteAlbum: (shopId: string, id: string) =>
    request<void>('DELETE', `/shops/${shopId}/albums/${id}`),

  deleteCategory: (shopId: string, id: string, moveTo?: string) =>
    request<void>('DELETE', `/shops/${shopId}/categories/${id}${moveTo ? `?move_to=${moveTo}` : ''}`),
  setAlbumCategory: (shopId: string, albumId: string, categoryId: string | null) =>
    request<Album>('PATCH', `/shops/${shopId}/albums/${albumId}/category`, {
      category_id: categoryId,
    }),

  presign: (shopId: string, albumId: string, size: number) =>
    request<{ photo_id: string; url: string }>('POST', '/uploads/presign', {
      shop_id: shopId,
      album_id: albumId,
      size,
    }),
  confirm: (shopId: string, photoIds: string[]) =>
    request<{ results: ConfirmResult[] }>('POST', '/photos/confirm', {
      shop_id: shopId,
      photo_ids: photoIds,
    }),
  updateCaption: (photoId: string, caption: string) =>
    request<Photo>('PATCH', `/photos/${photoId}`, { caption }),
  deletePhoto: (photoId: string) => request<void>('DELETE', `/photos/${photoId}`),

  getStats: (shopId: string, days: number) =>
    request<ShopStats>('GET', `/shops/${shopId}/stats?days=${days}`),

  getBilling: (shopId: string) => request<Billing>('GET', `/shops/${shopId}/billing`),
  quote: (shopId: string, plan: Plan, period: BillingPeriod) =>
    request<BillingQuote>('GET', `/shops/${shopId}/billing/quote?plan=${plan}&period=${period}`),
  subscribe: (shopId: string, plan: Plan, period: BillingPeriod) =>
    request<{ payment_id?: string; confirmation_url?: string; scheduled: boolean }>(
      'POST',
      `/shops/${shopId}/billing/subscribe`,
      { plan, period },
    ),
  cancelSubscription: (shopId: string) =>
    request<void>('POST', `/shops/${shopId}/billing/cancel`),
  resumeSubscription: (shopId: string) =>
    request<void>('POST', `/shops/${shopId}/billing/resume`),
  startTrial: (shopId: string) => request<void>('POST', `/shops/${shopId}/billing/trial`),
  listPayments: (shopId: string) =>
    request<{ payments: Payment[] }>('GET', `/shops/${shopId}/billing/payments`),

  // Админ-зона (role=admin).
  adminOverview: () =>
    request<{
      active_shops: number
      suspended_shops: number
      ready_photos: number
      open_complaints: number
      storage_used: number
    }>('GET', '/admin/overview'),
  adminListShops: () =>
    request<AdminShop[]>('GET', '/admin/shops'),
  adminListComplaints: (status?: string) =>
    request<AdminComplaint[]>('GET', `/admin/complaints${status ? `?status=${status}` : ''}`),
  adminSetComplaintStatus: (id: string, status: string) =>
    request<{ id: string; status: string }>('PATCH', `/admin/complaints/${id}`, { status }),
  adminBlockPhoto: (photoId: string, complaintId?: string) =>
    request<{ id: string; status: string }>('POST', `/admin/photos/${photoId}/block`, {
      complaint_id: complaintId ?? '',
      note: '',
    }),
  adminHideAlbum: (albumId: string, complaintId?: string) =>
    request<void>('POST', `/admin/albums/${albumId}/hide`, {
      complaint_id: complaintId ?? '',
      note: '',
    }),
  adminSuspendShop: (shopId: string, complaintId?: string) =>
    request<void>('POST', `/admin/shops/${shopId}/suspend`, {
      complaint_id: complaintId ?? '',
      note: '',
    }),
  adminUnhideAlbum: (albumId: string, note = '') =>
    request<void>('POST', `/admin/albums/${albumId}/unhide`, { complaint_id: '', note }),
  adminUnsuspendShop: (shopId: string, note = '') =>
    request<void>('POST', `/admin/shops/${shopId}/unsuspend`, { complaint_id: '', note }),
  adminListFlagged: () => request<FlaggedPhoto[]>('GET', '/admin/photos/flagged'),
  adminUnflagPhoto: (photoId: string) =>
    request<void>('POST', `/admin/photos/${photoId}/unflag`),
}
