// Типизированный клиент REST API /api/v1 (контракт: api/openapi.yaml).
const API = '/api/v1'

// Человеческие тексты для машинных кодов бэкенда. Сообщения самого API
// приходят по-английски: показывать их продавцу нельзя, кабинет русский.
export const API_ERRORS: Record<string, string> = {
  slug_taken: 'Этот адрес уже занят',
  invalid_slug: 'Адрес: 3–63 символа, латиница, цифры и одиночные дефисы',
  invalid_name: 'Укажите название',
  invalid_title: 'Укажите название (до 200 символов)',
  invalid_parent: 'Неверная родительская категория',
  too_deep: 'Больше двух уровней вложенности нельзя',
  slug_change_too_soon: 'Адрес можно менять не чаще раза в полгода',
  invalid_status: 'Неизвестный статус',
  invalid_description: 'Описание слишком длинное',
  photo_quota_exceeded: 'Достигнут лимит фотографий на тарифе',
  quota_exceeded: 'Закончилось место в хранилище',
  subscription_inactive: 'Подписка неактивна',
  not_found: 'Не найдено',
}

// errorText — текст для показа продавцу. Незнакомый код лучше показать
// как есть, чем проглотить: иначе диагностировать станет нечем.
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return API_ERRORS[e.code] ?? e.message
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
}

export type Plan = 'free' | 'basic' | 'pro'
export type BillingState = 'ok' | 'grace' | 'suspended'

export type Shop = {
  id: string
  slug: string
  name: string
  description: string
  plan: Plan
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
  watermark?: { enabled: boolean; text: string; opacity: number }
}

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

export type DowngradeAlbum = {
  id: string
  title: string
  photo_count: number
  views: number
  hidden_by_plan: boolean
}

export type DowngradeState = {
  plan: Plan
  max_photos: number
  total_photos: number
  visible_photos: number
  over_limit: boolean
  albums: DowngradeAlbum[]
}

export type PlanInfo = {
  id: Plan
  max_photos: number
  max_storage: number
  price_rub: number
}

export type Billing = {
  plan: Plan
  billing_state: BillingState
  paid_until: string | null
  usage: { photos: number; storage_used: number }
  limits: PlanInfo
  subscription: {
    plan: Plan
    status: 'active' | 'past_due' | 'canceled' | 'expired'
    period_end: string
    auto_renew: boolean
  } | null
  plans: PlanInfo[]
}

export type Album = {
  id: string
  parent_id: string | null
  title: string
  cover_photo_id: string | null
  sort_order: number
  status: AlbumStatus
  description: string
  category_id: string | null
  photo_count: number
}

export type Category = {
  id: string
  parent_id: string | null
  title: string
  slug: string
  sort_order: number
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
  urls?: { thumb: string; medium: string; large: string }
}

export type PhotoPage = {
  photos: Photo[]
  page: number
  per_page: number
  total: number
}

export type ConfirmResult = { photo_id: string; status: string; error?: string }

export type ShopStats = {
  days: number
  totals: { views: number; unique_visitors: number; lead_clicks: number }
  daily: { date: string; views: number; unique_visitors: number; lead_clicks: number }[]
  channels: { channel: string; clicks: number }[]
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
  updateAlbum: (shopId: string, albumId: string, patch: { title?: string; description?: string }) =>
    request<Album>('PATCH', `/shops/${shopId}/albums/${albumId}`, patch),
  setAlbumStatus: (shopId: string, albumId: string, status: AlbumStatus) =>
    request<Album>('PATCH', `/shops/${shopId}/albums/${albumId}`, { status }),
  createAlbum: (shopId: string, title: string, parentId?: string) =>
    request<Album>('POST', `/shops/${shopId}/albums`, {
      title,
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  // Страницами: альбом может содержать тысячи фото, выдача целиком
  // вешала кабинет.
  listPhotos: (shopId: string, albumId: string, page = 1) =>
    request<PhotoPage>('GET', `/shops/${shopId}/albums/${albumId}/photos?page=${page}`),

  listTabs: (shopId: string) => request<Tab[]>('GET', `/shops/${shopId}/tabs`),
  createTab: (shopId: string, title: string, slug: string) =>
    request<Tab>('POST', `/shops/${shopId}/tabs`, { title, slug }),
  reorderTab: (shopId: string, tabId: string, title: string, sortOrder: number) =>
    request<Tab>('PATCH', `/shops/${shopId}/tabs/${tabId}`, { title, sort_order: sortOrder }),
  deleteTab: (shopId: string, tabId: string) =>
    request<void>('DELETE', `/shops/${shopId}/tabs/${tabId}`),

  listSections: (shopId: string) => request<Section[]>('GET', `/shops/${shopId}/sections`),
  createSection: (shopId: string, tabId: string, title: string) =>
    request<Section>('POST', `/shops/${shopId}/tabs/${tabId}/sections`, { title }),
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
  updateCategory: (shopId: string, id: string, title: string, slug: string, sortOrder = 0) =>
    request<Category>('PATCH', `/shops/${shopId}/categories/${id}`, {
      title,
      slug,
      sort_order: sortOrder,
    }),
  // moveTo пустой — альбомы останутся без категории, но не удалятся.
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

  getDowngrade: (shopId: string) =>
    request<DowngradeState>('GET', `/shops/${shopId}/downgrade`),
  // Видимыми остаются перечисленные альбомы, остальные скрываются.
  // Ничего не удаляется.
  applyDowngrade: (shopId: string, albumIds: string[]) =>
    request<void>('PUT', `/shops/${shopId}/downgrade`, { album_ids: albumIds }),

  getStats: (shopId: string, days: number) =>
    request<ShopStats>('GET', `/shops/${shopId}/stats?days=${days}`),

  getBilling: (shopId: string) => request<Billing>('GET', `/shops/${shopId}/billing`),
  subscribe: (shopId: string, plan: Plan) =>
    request<{ payment_id: string; confirmation_url: string }>(
      'POST',
      `/shops/${shopId}/billing/subscribe`,
      { plan },
    ),
  cancelSubscription: (shopId: string) =>
    request<void>('POST', `/shops/${shopId}/billing/cancel`),

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
  adminListFlagged: () => request<FlaggedPhoto[]>('GET', '/admin/photos/flagged'),
  adminUnflagPhoto: (photoId: string) =>
    request<void>('POST', `/admin/photos/${photoId}/unflag`),
}
