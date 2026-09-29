import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type DragEvent } from 'react'
import { api, type Album, type AlbumStatus, type Category } from '../api'
import { createPhotoUppy, type UploadOutcome } from '../lib/uppy'

// Создание альбома по макету 11 · Desktop · v2 — окном поверх сетки.
//
// Порядок шагов навязан пайплайном: фотографии можно грузить только в
// существующий альбом (presign просит album_id). Поэтому сначала создаём
// альбом, потом догружаем в него выбранные файлы, и только после этого
// закрываем окно — иначе продавец решит, что фото пропали.
const MAX_TITLE = 30
// Предел описания задаёт сервер (albums_handlers.go): показывать 3 500,
// как в макете, значит обещать то, что бэкенд отклонит.
const MAX_DESCRIPTION = 2000

const ACCESS: { id: AlbumStatus; label: string }[] = [
  { id: 'published', label: 'Опубликован' },
  { id: 'unlisted', label: 'По ссылке' },
  { id: 'draft', label: 'Черновик' },
]

export function NewAlbumDialog({
  shopId,
  categories,
  onClose,
}: {
  shopId: string
  categories: Category[]
  onClose: (created?: Album) => void
}) {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [status, setStatus] = useState<AlbumStatus>('published')
  const [files, setFiles] = useState<File[]>([])
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<'no' | 'album' | 'photos'>('no')
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  // Закрытие с набранной формой спрашивает подтверждение: выбранные файлы
  // и текст иначе пропадали молча, а заново тащить полсотни снимков обидно.
  const dirty = files.length > 0 || title.trim() !== '' || description.trim() !== ''
  const close = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  // Без фотографий публиковать нечего: покупатель попадёт в пустой альбом.
  const forcedDraft = files.length === 0
  const effectiveStatus: AlbumStatus = forcedDraft ? 'draft' : status

  const addFiles = (list: FileList | null) => {
    if (!list) return
    setFiles((prev) => [...prev, ...Array.from(list)])
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    addFiles(e.dataTransfer.files)
  }

  const submit = async () => {
    const name = title.trim()
    if (!name) return
    setError('')
    setBusy('album')
    let album: Album
    try {
      album = await api.createAlbum(shopId, name)
    } catch {
      setError('Не удалось создать альбом.')
      setBusy('no')
      return
    }

    // Остальные поля — отдельными запросами: создание принимает только
    // название. Их отказ не отменяет уже созданный альбом, поэтому
    // сообщаем и оставляем окно открытым.
    try {
      if (description.trim()) {
        await api.updateAlbum(shopId, album.id, { description: description.trim() })
      }
      if (effectiveStatus !== album.status) {
        await api.setAlbumStatus(shopId, album.id, effectiveStatus)
      }
      if (categoryId) await api.setAlbumCategory(shopId, album.id, categoryId)
    } catch {
      setError('Альбом создан, но часть настроек не сохранилась — поправьте их в альбоме.')
    }

    if (files.length === 0) {
      void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
      setBusy('no')
      onClose(album)
      return
    }

    setBusy('photos')
    const uppy = createPhotoUppy({
      shopId,
      albumId: album.id,
      onBatchConfirmed: () => {
        void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
        void queryClient.invalidateQueries({ queryKey: ['billing', shopId] })
      },
      onOutcome: setOutcome,
    })
    for (const file of files) {
      try {
        uppy.addFile({ name: file.name, type: file.type, data: file })
      } catch {
        // Uppy отклоняет файл по своим ограничениям (тип, размер) и сам
        // покажет причину в outcome — молча пропускаем.
      }
    }
    await uppy.upload()
    uppy.destroy()
    void queryClient.invalidateQueries({ queryKey: ['albums', shopId] })
    setBusy('no')
    onClose(album)
  }

  const disabled = busy !== 'no' || !title.trim()

  return (
    <div className="modal__back" role="dialog" aria-modal="true" aria-label="Новый альбом">
      <div className="modal">
        <div className="modal__head">
          <div>
            <h2>Новый альбом</h2>
            <p>Добавьте фото и заполните данные — всё можно изменить позже в самом альбоме</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={close} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div className="modal__body">
          <div>
            <div className="field__row">
              <span>Фото</span>
              <span className="field__cnt">необязательно</span>
            </div>
            <div
              className={`drop ${over ? 'drop--over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={drop}
            >
              {files.length === 0 ? (
                <>
                  <p>Перетащите фото сюда</p>
                  <small>или выберите файлы с компьютера</small>
                  <button className="btn btn--ghost btn--sm" onClick={() => fileInput.current?.click()}>
                    Выбрать файлы
                  </button>
                  <small>Можно загрузить сразу несколько фото</small>
                </>
              ) : (
                <>
                  <p>Выбрано файлов: {files.length}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <button className="btn btn--ghost btn--sm" onClick={() => fileInput.current?.click()}>
                      Добавить ещё
                    </button>
                    <button className="btn btn--quiet btn--sm" onClick={() => setFiles([])}>
                      Очистить
                    </button>
                  </div>
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            <p className="hint">Форматы JPEG, PNG, WebP, HEIC · до 10 МБ на одно фото</p>
          </div>

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
                placeholder="Например, Stone Island · осень"
                autoFocus
              />
            </label>

            <label className="field">
              <span className="field__row">
                <span>Описание</span>
                <span className="field__cnt">необязательно</span>
                <span className="spacer" />
                <span className="field__cnt">
                  {description.length} / {MAX_DESCRIPTION}
                </span>
              </span>
              <textarea
                className="inp"
                rows={3}
                value={description}
                maxLength={MAX_DESCRIPTION}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Размеры, материалы, условия заказа…"
              />
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
                    aria-pressed={effectiveStatus === a.id}
                    disabled={forcedDraft && a.id !== 'draft'}
                    onClick={() => setStatus(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              {forcedDraft && <p className="hint">Пока нет фото, альбом сохранится как черновик</p>}
            </div>
          </div>
        </div>

        <div className="modal__foot">
          <p className="hint">
            {confirmClose ? 'Закрыть без сохранения?' : 'Обязательно только название'}
          </p>
          <span className="spacer" />
          {error && <p className="hint text-danger">{error}</p>}
          {outcome?.reason && <p className="hint text-danger">Загрузка прервана: {outcome.reason}</p>}
          <button className="btn btn--ghost" onClick={close} disabled={busy !== 'no'}>
            {confirmClose ? 'Да, закрыть' : 'Отмена'}
          </button>
          {confirmClose ? (
            <button className="btn btn--primary" onClick={() => setConfirmClose(false)}>
              Продолжить
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={disabled}>
              {busy === 'photos' ? 'Загружаем фото…' : busy === 'album' ? 'Создаём…' : 'Создать альбом'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
