'use client'

import { CircleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

// Объект жалобы: витрина, альбом или фото. id — альбома или фото; name —
// имя витрины или название альбома; position — «12 из 48» у фото.
export type ComplaintTarget = {
  slug: string
  kind: 'shop' | 'album' | 'photo'
  id?: string
  name: string
  token?: string
  position?: string
}

export type ComplaintDialogProps = {
  target: ComplaintTarget
  onClose: () => void
  onSent: () => void
}

const REASONS = [
  ['prohibited', 'Запрещённые товары', 'Оружие, наркотики, лекарства, алкоголь, табак'],
  ['violence', 'Насилие или жестокость', 'Сцены насилия, травмы, жестокость к животным'],
  ['adult', 'Контент 18+', 'Обнажённое тело, сексуальный контент'],
  ['fraud', 'Мошенничество', 'Обман покупателей, предоплата без товара'],
  ['counterfeit', 'Подделка или нарушение прав', 'Контрафакт, чужие фото или товарные знаки'],
  ['hate', 'Оскорбления или ненависть', 'Угрозы, дискриминация, унижение людей'],
  ['spam', 'Спам', 'Реклама не по теме, повторяющиеся альбомы'],
  ['other', 'Другое', 'Опишите проблему в поле ниже'],
] as const

const MAX = 500

// Окно жалобы покупателя (макет 15 · «Жалоба»): причина обязательна,
// комментарий — только для «Другое». Почту не спрашиваем: жалоба анонимная,
// объект и ссылку на него определяет сервер. Не отправилось — ошибка в окне,
// причина и текст остаются, «Отправить жалобу» пробует снова.
// Нативный <dialog> в модальном режиме сам держит фокус и закрывается по Esc.
export function ComplaintDialog({ target, onClose, onSent }: ComplaintDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const other = reason === 'other'
  const ready = reason !== '' && (!other || comment.trim() !== '') && !sending

  const send = async () => {
    if (!ready) return
    setSending(true)
    setFailed(false)
    try {
      const res = await fetch(`/api/v1/public/shops/${encodeURIComponent(target.slug)}/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(target.token ? { 'X-Album-Token': target.token } : {}) },
        body: JSON.stringify({ target: target.kind, target_id: target.id, reason, comment: comment.trim() }),
      })
      if (!res.ok) throw new Error(String(res.status))
      onSent()
    } catch {
      setFailed(true)
      setSending(false)
    }
  }

  const title = { shop: 'витрину', album: 'альбом', photo: 'фото' }[target.kind]
  const what = {
    shop: 'Витрина ',
    album: 'Альбом ',
    photo: `Фото ${target.position ?? ''} в альбоме `,
  }[target.kind]
  const name = target.kind === 'shop' ? target.name : `«${target.name}»`

  return (
    <dialog
      ref={ref}
      className="cdlg"
      aria-labelledby="cdlg-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <h2 id="cdlg-title">Пожаловаться на {title}</h2>
        <p className="cdlg__lead">
          {what}
          <b>{name}</b>. Жалобу проверит модерация вуад, продавец не&nbsp;узнает, кто её отправил.
        </p>
        {failed && (
          <div className="cdlg__error" role="alert">
            <CircleAlert size={18} strokeWidth={1.8} aria-hidden="true" />
            <p>
              <b>Не удалось отправить жалобу</b>
              Проверьте интернет и попробуйте ещё раз — причина и комментарий сохранились.
            </p>
          </div>
        )}
        <fieldset className="cdlg__reasons">
          <legend className="sr-only">Причина</legend>
          {REASONS.map(([code, label, hint]) => (
            <label key={code} className="cdlg__reason">
              <input
                type="radio"
                name="reason"
                value={code}
                checked={reason === code}
                onChange={() => setReason(code)}
              />
              <span>
                <b>{label}</b>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="cdlg__field">
          <label htmlFor="cdlg-comment">
            {other ? (
              'Опишите, что не так'
            ) : (
              <>
                Подробнее <span>· необязательно</span>
              </>
            )}
          </label>
          <span aria-hidden="true">
            {comment.length} / {MAX}
          </span>
          <textarea
            id="cdlg-comment"
            value={comment}
            maxLength={MAX}
            required={other}
            placeholder="Что именно не так — это поможет быстрее проверить жалобу"
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        <div className="cdlg__buttons">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            Отправить жалобу
          </button>
        </div>
      </form>
    </dialog>
  )
}
