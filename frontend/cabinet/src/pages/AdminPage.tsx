import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type AdminComplaint } from '../api'

// Админ-зона: жалобы правообладателей и фото, помеченные стоп-словами.
// Доступ только для role=admin (бэкенд отвечает 404 остальным).

const STATUS_LABELS: Record<AdminComplaint['status'], string> = {
  open: 'Новая',
  in_review: 'В работе',
  resolved: 'Решена',
  rejected: 'Отклонена',
}

export function AdminPage() {
  const [tab, setTab] = useState<'overview' | 'complaints' | 'flagged' | 'sellers'>('overview')
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-ink">Платформа</h1>
      <div className="mb-4 flex flex-wrap gap-2">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
          Сводка
        </TabButton>
        <TabButton active={tab === 'complaints'} onClick={() => setTab('complaints')}>
          Жалобы
        </TabButton>
        <TabButton active={tab === 'flagged'} onClick={() => setTab('flagged')}>
          Стоп-слова
        </TabButton>
        <TabButton active={tab === 'sellers'} onClick={() => setTab('sellers')}>
          Продавцы
        </TabButton>
      </div>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'complaints' && <ComplaintsTab />}
      {tab === 'flagged' && <FlaggedTab />}
      {tab === 'sellers' && <SellersTab />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm font-medium ${
        active ? 'bg-brand text-on-brand' : 'bg-white text-ink-2 border border-line-strong'
      }`}
    >
      {children}
    </button>
  )
}

function ComplaintsTab() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState('open')
  const complaints = useQuery({
    queryKey: ['admin-complaints', status],
    queryFn: () => api.adminListComplaints(status || undefined),
  })
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['admin-complaints'] })

  const setComplaintStatus = useMutation({
    mutationFn: ({ id, st }: { id: string; st: string }) =>
      api.adminSetComplaintStatus(id, st),
    onSuccess: refresh,
  })
  const blockPhoto = useMutation({
    mutationFn: ({ photoId, complaintId }: { photoId: string; complaintId: string }) =>
      api.adminBlockPhoto(photoId, complaintId),
    onSuccess: refresh,
  })
  const hideAlbum = useMutation({
    mutationFn: ({ albumId, complaintId }: { albumId: string; complaintId: string }) =>
      api.adminHideAlbum(albumId, complaintId),
    onSuccess: refresh,
  })
  const suspendShop = useMutation({
    mutationFn: ({ shopId, complaintId }: { shopId: string; complaintId: string }) =>
      api.adminSuspendShop(shopId, complaintId),
    onSuccess: refresh,
  })

  if (complaints.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (complaints.isError) return <p className="text-danger">Не удалось загрузить жалобы.</p>

  return (
    <div>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        className="mb-4 rounded border border-line-strong px-2 py-1.5 text-sm"
      >
        <option value="open">Новые</option>
        <option value="in_review">В работе</option>
        <option value="resolved">Решённые</option>
        <option value="rejected">Отклонённые</option>
        <option value="">Все</option>
      </select>

      {complaints.data.length === 0 && <p className="text-ink-2">Жалоб нет.</p>}

      <ul className="space-y-3">
        {complaints.data.map((c) => (
          <li key={c.id} className="rounded-lg border border-line bg-white p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">
                {STATUS_LABELS[c.status]} ·{' '}
                {new Date(c.created_at).toLocaleString('ru-RU')}
              </span>
              {c.shop_slug && (
                <a
                  href={`/${c.shop_slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-brand hover:underline"
                >
                  /{c.shop_slug}
                </a>
              )}
            </div>
            <p className="mb-1 text-sm break-all text-ink-2">{c.content_url}</p>
            <p className="mb-2 text-sm whitespace-pre-wrap text-ink">{c.reason}</p>
            <p className="mb-3 text-sm text-ink-2">
              Заявитель: {c.reporter_name} &lt;{c.reporter_email}&gt;
            </p>
            <div className="flex flex-wrap gap-2 text-sm">
              {c.status === 'open' && (
                <ActionButton
                  onClick={() => setComplaintStatus.mutate({ id: c.id, st: 'in_review' })}
                >
                  В работу
                </ActionButton>
              )}
              {c.photo_id && (
                <ActionButton
                  danger
                  onClick={() =>
                    blockPhoto.mutate({ photoId: c.photo_id!, complaintId: c.id })
                  }
                >
                  Скрыть фото
                </ActionButton>
              )}
              {c.photo_album_id && (
                <ActionButton
                  danger
                  onClick={() =>
                    hideAlbum.mutate({ albumId: c.photo_album_id!, complaintId: c.id })
                  }
                >
                  Скрыть альбом
                </ActionButton>
              )}
              {c.shop_id && (
                <ActionButton
                  danger
                  onClick={() =>
                    suspendShop.mutate({ shopId: c.shop_id!, complaintId: c.id })
                  }
                >
                  Заблокировать магазин
                </ActionButton>
              )}
              {(c.status === 'open' || c.status === 'in_review') && (
                <>
                  <ActionButton
                    onClick={() => setComplaintStatus.mutate({ id: c.id, st: 'resolved' })}
                  >
                    Решена
                  </ActionButton>
                  <ActionButton
                    onClick={() => setComplaintStatus.mutate({ id: c.id, st: 'rejected' })}
                  >
                    Отклонить
                  </ActionButton>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FlaggedTab() {
  const queryClient = useQueryClient()
  const flagged = useQuery({
    queryKey: ['admin-flagged'],
    queryFn: api.adminListFlagged,
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin-flagged'] })
  const block = useMutation({
    mutationFn: (photoId: string) => api.adminBlockPhoto(photoId),
    onSuccess: refresh,
  })
  const unflag = useMutation({
    mutationFn: (photoId: string) => api.adminUnflagPhoto(photoId),
    onSuccess: refresh,
  })

  if (flagged.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (flagged.isError) return <p className="text-danger">Не удалось загрузить список.</p>
  if (flagged.data.length === 0)
    return <p className="text-ink-2">Нет фото на ручной проверке.</p>

  return (
    <ul className="space-y-3">
      {flagged.data.map((p) => (
        <li key={p.id} className="rounded-lg border border-line bg-white p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-sm text-ink-2">
              /{p.shop_slug} · статус {p.status}
            </span>
          </div>
          <p className="mb-3 text-sm whitespace-pre-wrap text-ink">{p.caption}</p>
          <div className="flex gap-2 text-sm">
            <ActionButton danger onClick={() => block.mutate(p.id)}>
              Скрыть фото
            </ActionButton>
            <ActionButton onClick={() => unflag.mutate(p.id)}>Снять флаг</ActionButton>
          </div>
        </li>
      ))}
    </ul>
  )
}

function ActionButton({
  onClick,
  danger,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded border px-3 py-1.5 font-medium ${
        danger
          ? 'border-line-strong text-danger'
          : 'border-line-strong text-ink-2 hover:bg-surface-alt'
      }`}
    >
      {children}
    </button>
  )
}

function formatBytes(bytes: number): string {
  const gb = 1024 ** 3
  return bytes >= gb ? `${(bytes / gb).toFixed(1)} ГБ` : `${Math.round(bytes / 1024 ** 2)} МБ`
}

function OverviewTab() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.adminOverview() })
  if (q.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (q.isError) return <p className="text-danger">Не удалось загрузить сводку.</p>

  const cards = [
    { label: 'Активные магазины', value: String(q.data.active_shops) },
    { label: 'Скрыты за неоплату', value: String(q.data.suspended_shops) },
    { label: 'Фотографий', value: String(q.data.ready_photos) },
    { label: 'Открытых жалоб', value: String(q.data.open_complaints) },
    { label: 'Хранилище', value: formatBytes(q.data.storage_used) },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded border border-line p-4">
          <div className="text-sm text-ink-2">{c.label}</div>
          <div className="text-2xl font-semibold text-ink">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

// Продавцы отсортированы по числу жалоб: модератору важно отличить
// единичный случай от системы, а не листать список по алфавиту.
function SellersTab() {
  const q = useQuery({ queryKey: ['admin', 'shops'], queryFn: () => api.adminListShops() })
  if (q.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (q.isError) return <p className="text-danger">Не удалось загрузить продавцов.</p>
  if (q.data.length === 0) return <p className="text-ink-2">Продавцов пока нет.</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-ink-2">
          <tr>
            <th className="py-2">Магазин</th>
            <th className="py-2">Почта</th>
            <th className="py-2">Тариф</th>
            <th className="py-2">Фото</th>
            <th className="py-2">Место</th>
            <th className="py-2">Жалобы</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((s) => (
            <tr key={s.id} className="border-t border-line">
              <td className="py-2">
                <a href={`/${s.slug}`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  {s.name}
                </a>
                {s.billing_state === 'suspended' && (
                  <span className="ml-2 badge badge--warn">скрыт</span>
                )}
              </td>
              <td className="py-2 text-ink-2">{s.email}</td>
              <td className="py-2 text-ink-2">{s.plan}</td>
              <td className="py-2 text-ink-2">{s.photos}</td>
              <td className="py-2 text-ink-2">{formatBytes(s.storage_used)}</td>
              <td className={`py-2 ${s.complaints > 0 ? 'font-medium text-danger' : 'text-ink-3'}`}>
                {s.complaints}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
