// Типизированный клиент REST API /api/v1 (контракт: api/openapi.yaml).
const API = '/api/v1'

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

export type User = { id: string; email: string | null }

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
  is_hidden: boolean
  photo_count: number
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

export type ConfirmResult = { photo_id: string; status: string; error?: string }

export const api = {
  register: (email: string, password: string) =>
    request<User>('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) =>
    request<User>('POST', '/auth/login', { email, password }),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<User>('GET', '/auth/me'),

  listShops: () => request<Shop[]>('GET', '/shops'),
  createShop: (slug: string, name: string) => request<Shop>('POST', '/shops', { slug, name }),
  getShop: (shopId: string) => request<Shop>('GET', `/shops/${shopId}`),

  listAlbums: (shopId: string) => request<Album[]>('GET', `/shops/${shopId}/albums`),
  createAlbum: (shopId: string, title: string, parentId?: string) =>
    request<Album>('POST', `/shops/${shopId}/albums`, {
      title,
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  listPhotos: (shopId: string, albumId: string) =>
    request<Photo[]>('GET', `/shops/${shopId}/albums/${albumId}/photos`),

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

  getBilling: (shopId: string) => request<Billing>('GET', `/shops/${shopId}/billing`),
  subscribe: (shopId: string, plan: Plan) =>
    request<{ payment_id: string; confirmation_url: string }>(
      'POST',
      `/shops/${shopId}/billing/subscribe`,
      { plan },
    ),
  cancelSubscription: (shopId: string) =>
    request<void>('POST', `/shops/${shopId}/billing/cancel`),
}
