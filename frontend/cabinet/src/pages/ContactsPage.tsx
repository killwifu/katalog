import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type ShopContacts, type ShopSettings } from '../api'
import { useShop } from './AppLayout'

// Каналы в том же порядке, в каком витрина рисует кнопки покупателю.
const CHANNELS = [
  { key: 'telegram', label: 'Telegram', placeholder: 'ник без @', hint: 'Ссылка вида t.me/ник' },
  { key: 'whatsapp', label: 'WhatsApp', placeholder: '79991234567', hint: 'Только цифры, без плюса и пробелов' },
  { key: 'vk', label: 'VK', placeholder: 'ник или ссылка', hint: 'Предзаполнить текст сообщения VK не позволяет' },
  { key: 'max', label: 'MAX', placeholder: 'ник или ссылка', hint: '' },
] as const

export function ContactsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: ['shop', shop.id], queryFn: () => api.getShop(shop.id) })

  const [draft, setDraft] = useState<ShopContacts | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<ShopSettings | null>(null)
  const contacts = draft ?? current.data?.contacts ?? {}
  const settings = settingsDraft ?? current.data?.settings ?? {}

  const save = useMutation({
    mutationFn: async () => {
      if (draft !== null) await api.updateContacts(shop.id, contacts)
      if (settingsDraft !== null) await api.updateSettings(shop.id, settings)
    },
    onSuccess: () => {
      setDraft(null)
      setSettingsDraft(null)
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
    },
  })

  if (current.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (current.isError) return <p className="text-danger">Не удалось загрузить контакты.</p>

  const filled = CHANNELS.filter((c) => (contacts[c.key] ?? '').trim())
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit}>
      <div className="page__head">
        <h1>Контакты</h1>
      </div>
      <p className="page__lead">
        Кнопки, по которым покупатель напишет вам с витрины. Заполните хотя бы один канал —
        без него каталог не приводит заявок, а значит не работает.
      </p>

      {filled.length === 0 && (
        <div className="alert alert--warn">
          Ни один канал не заполнен: на витрине кнопок связи сейчас нет.
        </div>
      )}

      <div className="cols md:grid-cols-2">
        <div>
          {CHANNELS.map((c) => (
            <label key={c.key} className="field">
              <span>{c.label}</span>
              <input
                className="inp"
                value={contacts[c.key] ?? ''}
                onChange={(e) => setDraft({ ...contacts, [c.key]: e.target.value })}
                placeholder={c.placeholder}
                maxLength={100}
              />
              {c.hint && <p className="hint">{c.hint}</p>}
            </label>
          ))}

          <label className="field">
            <span>Когда отвечаете</span>
            <input
              className="inp"
              value={settings.reply_time ?? ''}
              onChange={(e) => setSettingsDraft({ ...settings, reply_time: e.target.value })}
              placeholder="Отвечаю с 10:00 до 22:00"
              maxLength={100}
            />
            <p className="hint">
              Покажется рядом с кнопкой «Написать». Помогает покупателю не ждать ответа ночью.
            </p>
          </label>

          <button
            type="submit"
            className="btn btn--primary btn--block-mobile"
            disabled={(draft === null && settingsDraft === null) || save.isPending}
          >
            {save.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {save.isError && <p className="hint text-danger">Не удалось сохранить.</p>}
        </div>

        {/* Предпросмотр — чтобы продавец видел результат до того, как
            отправит ссылку покупателю, а не после. */}
        <div>
          <div className="box">
            <h2>Как увидит покупатель</h2>
            {filled.length === 0 ? (
              <p className="text-sm text-ink-3">Заполните канал — здесь появятся кнопки.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {filled.map((c) => (
                  <span key={c.key} className="btn btn--ghost btn--sm">
                    {c.label}
                  </span>
                ))}
              </div>
            )}
            <p className="hint">
              В сообщение подставится подпись фотографии — шаблон меняется в настройках.
            </p>
          </div>
        </div>
      </div>
    </form>
  )
}
