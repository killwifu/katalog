import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, errorText, type Album, type AlbumStatus, type Category } from '../api'

// Редактирование альбома по макету 12 · Desktop · v2 — тем же окном, что и
// создание. Кнопка сохранения активна только когда что-то поменялось: в
// макете это отдельный кадр «Есть изменения».
const MAX_TITLE = 30
const MAX_DESCRIPTION = 2000

const ACCESS: { id: AlbumStatus; label: string }[] = [
  { id: 'published', label: 'Опубликован' },
  { id: 'unlisted', label: 'По ссылке' },
  { id: 'draft', label: 'Черновик' },
]

export function EditAlbumDialog({
  shopId,
  album,
  categories,
  onClose,
}: {
  shopId: string
  album: Album
  categories: Category[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(album.title)
  const [description, setDescription] = useState(album.description)
  const [categoryId, setCategoryId] = useState(album.category_id ?? '')
  const [status, setStatus] = useState<AlbumStatus>(album.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)

  const dirty =
    title !== album.title ||
    description !== album.description ||
    categoryId !== (album.category_id ?? '') ||
    status !== album.status
  // Публиковать пустой альбом незачем: покупатель попадёт на пустую страницу.
  const canPublish = album.photo_count > 0

  const close = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const save = async () => {
    const name = title.trim()
    if (!name) return
    setBusy(true)
    setError('')
    try {
      if (name !== album.title || description !== album.description) {
        await api.updateAlbum(shopId, album.id, { title: name, description })
      }
      if (status !== album.status) await api.setAlbumStatus(shopId, album.id, status)
      if (categoryId !== (album.category_id ?? '')) {
        await api.setAlbumCategory(shopId, album.id, categoryId || null)
      }
      void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal__back" role="dialog" aria-modal="true" aria-label="Редактировать альбом">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal__head">
          <div>
            <h2>Редактировать альбом</h2>
            <p>Название и описание видит покупатель на витрине</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={close} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div className="modal__body" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <label className="field">
              <span className="field__row">
                <span>
                  Название <span className="req">*</span>
                </span>
                <span className="spacer" />
                <span className="field__cnt">
                  {title.length} / {MAX_TITLE}
                </span>
              </span>
              <input
                className="inp"
                value={title}
                maxLength={MAX_TITLE}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </label>

            <label className="field">
              <span className="field__row">
                <span>Описание</span>
                <span className="spacer" />
                <span className="field__cnt">
                  {description.length} / {MAX_DESCRIPTION}
                </span>
              </span>
              <textarea
                className="inp"
                rows={4}
                value={description}
                maxLength={MAX_DESCRIPTION}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Размеры, материалы, условия заказа…"
              />
              <p className="hint">Переносы строк сохранятся.</p>
            </label>

            <label className="field">
              <span>Категория</span>
              <select className="inp" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Без категории</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>

            <div className="field">
              <span>Доступ</span>
              <div className="segbar">
                {ACCESS.map((a) => (
                  <button
                    key={a.id}
                    aria-pressed={status === a.id}
                    disabled={!canPublish && a.id !== 'draft'}
                    onClick={() => setStatus(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              {!canPublish && <p className="hint">В альбоме нет фото — доступен только черновик</p>}
            </div>
          </div>
        </div>

        <div className="modal__foot">
          {confirmClose ? (
            <p className="hint">Закрыть без сохранения?</p>
          ) : (
            error && <p className="hint text-danger">{error}</p>
          )}
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={close} disabled={busy}>
            {confirmClose ? 'Да, закрыть' : 'Отмена'}
          </button>
          {confirmClose ? (
            <button className="btn btn--primary" onClick={() => setConfirmClose(false)}>
              Продолжить правку
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={busy || !dirty || !title.trim()}
            >
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
