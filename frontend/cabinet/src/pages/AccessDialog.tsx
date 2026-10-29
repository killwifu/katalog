import { CircleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { api, type Album, type AlbumStatus, type Plan } from '../api'
import { Icon } from '../lib/icons'
import { plural } from '../lib/uploadRun'
import { useDialogClose } from '../lib/useDialogClose'
import { PasswordControl, passwordError, type PasswordChoice } from './PasswordControl'
import { useSingleFlight } from '../lib/singleFlight'
import { Portal } from '../lib/Portal'

// «Изменить доступ» по макету 10 · Desktop · v2 — для одного альбома
// (клик по статусу на карточке) и для нескольких выбранных.
//
// Доступ и пароль меняются одним окном и одной кнопкой: для продавца это
// один вопрос — «кто увидит альбом».
const ACCESS: { id: AlbumStatus; label: string; one: string; many: string }[] = [
  {
    id: 'published',
    label: 'Опубликован',
    one: 'Альбом увидят все посетители витрины',
    many: 'Альбомы увидят все посетители витрины',
  },
  {
    id: 'unlisted',
    label: 'По ссылке',
    one: 'Альбом откроется только по прямой ссылке',
    many: 'Альбомы откроются только по прямой ссылке',
  },
  {
    id: 'draft',
    label: 'Черновик',
    one: 'Альбом не виден покупателям, даже по ссылке',
    many: 'Альбомы не видны покупателям, даже по ссылке',
  },
]

export function AccessDialog({
  shopId,
  plan,
  albums,
  onClose,
}: {
  shopId: string
  plan: Plan
  albums: Album[]
  // done — текст уведомления; пусто, если ничего не меняли.
  onClose: (done?: string) => void
}) {
  const many = albums.length > 1
  // У нескольких альбомов статусы могут быть разными — тогда ничего не
  // выбрано заранее, чтобы «Сохранить» не поменяло доступ молча.
  const same = albums.every((a) => a.status === albums[0].status)
  const [status, setStatus] = useState<AlbumStatus | null>(same ? albums[0].status : null)
  const anyPassword = albums.some((a) => a.has_password)
  const [password, setPassword] = useState<PasswordChoice>({ mode: anyPassword ? 'keep' : 'none', value: '' })
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const target = albums.filter((a) => a.status !== status)
  // По макету здесь альбом без фото опубликовать можно (в отличие от
  // создания) — но предупреждаем: покупатель увидит пустую страницу.
  const empty = status !== 'draft' && status !== null ? albums.filter((a) => a.photo_count === 0) : []
  const current = ACCESS.find((a) => a.id === status)

  const backdrop = useDialogClose(() => {
    if (!busy) onClose()
  })

  // Что из пароля реально надо отправить: «оставить» и «без пароля» у
  // альбома, где его и так нет, — не изменения.
  const passwordPatch = (a: Album): string | undefined =>
    password.mode === 'set' ? password.value : password.mode === 'none' && a.has_password ? '' : undefined
  const passwordTargets = albums.filter((a) => passwordPatch(a) !== undefined)

  // Двойной клик не запускает действие дважды.
  const flight = useSingleFlight()
  const save = async () => {
    if (!flight.enter()) return
    try {
      if (!status) return
      setSubmitted(true)
      if (passwordError(password)) return
      if (target.length === 0 && passwordTargets.length === 0) {
        onClose()
        return
      }
      setBusy(true)
      setError('')
      // Сначала пароль, потом доступ: открыть альбом покупателям раньше,
      // чем на нём появится пароль, было бы ошибкой в неправильную сторону.
      const touched = albums.filter((a) => target.includes(a) || passwordTargets.includes(a))
      const results = await Promise.allSettled(
        touched.map(async (a) => {
          const pwd = passwordPatch(a)
          if (pwd !== undefined) await api.updateAlbum(shopId, a.id, { password: pwd })
          if (target.includes(a)) await api.setAlbumStatus(shopId, a.id, status)
        }),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      setBusy(false)
      if (ok < touched.length) {
        // Окно остаётся открытым: продавец должен видеть, что применилось
        // не всё, и иметь возможность повторить.
        setError(
          ok === 0
            ? 'Не удалось сохранить изменения. Проверьте интернет и попробуйте ещё раз'
            : `Сохранено ${ok} из ${touched.length}. Попробуйте ещё раз для остальных`,
        )
        return
      }
      onClose(many ? `Доступ изменён у ${ok} ${plural(ok, 'альбома', 'альбомов', 'альбомов')}` : 'Доступ изменён')
    } finally {
      flight.leave()
    }
  }

  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label="Изменить доступ" {...backdrop}>
      <div className="modal modal--form modal--access">
        <div className="modal__head">
          <div>
            <h2>Изменить доступ</h2>
            <p>
              {many
                ? `Применится к ${albums.length} выбранным ${plural(albums.length, 'альбому', 'альбомам', 'альбомам')}`
                : `Альбом «${albums[0].title}»`}
            </p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={() => onClose()} aria-label="Закрыть" disabled={busy}>
            <Icon as={X} size={20} />
          </button>
        </div>
        <div className="modal__text">
          <div className="field">
            <span>Доступ</span>
            <div className="segbar">
              {ACCESS.map((a) => (
                <button key={a.id} aria-pressed={status === a.id} disabled={busy} onClick={() => setStatus(a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
            <p className="hint hint--i">
              {current ? (many ? current.many : current.one) : 'У выбранных альбомов разный доступ — выберите, какой сделать у всех'}
            </p>
            {empty.length > 0 && (
              <p className="hint hint--warn">
                {many
                  ? `${empty.length} ${plural(empty.length, 'альбом пока без фото', 'альбома пока без фото', 'альбомов пока без фото')} — покупатели увидят пустые альбомы`
                  : 'В альбоме нет фото — покупатели увидят пустой альбом'}
              </p>
            )}
          </div>
          <PasswordControl
            plan={plan}
            hasPassword={anyPassword}
            many={many}
            choice={password}
            onChange={(next) => {
              setPassword(next)
              setSubmitted(false)
            }}
            showError={submitted}
            disabled={busy}
          />
          {/* Ошибка сохранения — красной плашкой над кнопками (макет 10). */}
          {error && (
            <p className="al__err" role="alert">
              <Icon as={CircleAlert} size={16} />
              {error}
            </p>
          )}
        </div>
        <div className="modal__foot">
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={() => onClose()} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={busy || !status}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div></Portal>
  )
}
