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
  const [tab, setTab] = useState<'complaints' | 'flagged'>('complaints')
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-gray-900">Модерация</h1>
      <div className="mb-4 flex gap-2">
        <TabButton active={tab === 'complaints'} onClick={() => setTab('complaints')}>
          Жалобы
        </TabButton>
        <TabButton active={tab === 'flagged'} onClick={() => setTab('flagged')}>
          Стоп-слова
        </TabButton>
      </div>
      {tab === 'complaints' ? <ComplaintsTab /> : <FlaggedTab />}
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
        active ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border border-gray-300'
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

  if (complaints.isPending) return <p className="text-gray-500">Загрузка…</p>
  if (complaints.isError) return <p className="text-red-600">Не удалось загрузить жалобы.</p>

  return (
    <div>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        className="mb-4 rounded border border-gray-300 px-2 py-1.5 text-sm"
      >
        <option value="open">Новые</option>
        <option value="in_review">В работе</option>
        <option value="resolved">Решённые</option>
        <option value="rejected">Отклонённые</option>
        <option value="">Все</option>
      </select>

      {complaints.data.length === 0 && <p className="text-gray-500">Жалоб нет.</p>}

      <ul className="space-y-3">
        {complaints.data.map((c) => (
          <li key={c.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-gray-900">
                {STATUS_LABELS[c.status]} ·{' '}
                {new Date(c.created_at).toLocaleString('ru-RU')}
              </span>
              {c.shop_slug && (
                <a
                  href={`/${c.shop_slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  /{c.shop_slug}
                </a>
              )}
            </div>
            <p className="mb-1 text-sm break-all text-gray-500">{c.content_url}</p>
            <p className="mb-2 text-sm whitespace-pre-wrap text-gray-800">{c.reason}</p>
            <p className="mb-3 text-sm text-gray-500">
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

  if (flagged.isPending) return <p className="text-gray-500">Загрузка…</p>
  if (flagged.isError) return <p className="text-red-600">Не удалось загрузить список.</p>
  if (flagged.data.length === 0)
    return <p className="text-gray-500">Нет фото на ручной проверке.</p>

  return (
    <ul className="space-y-3">
      {flagged.data.map((p) => (
        <li key={p.id} className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-sm text-gray-500">
              /{p.shop_slug} · статус {p.status}
            </span>
          </div>
          <p className="mb-3 text-sm whitespace-pre-wrap text-gray-800">{p.caption}</p>
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
          ? 'border-red-300 text-red-700 hover:bg-red-50'
          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  )
}
