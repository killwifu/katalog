import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { api, errorText, type ShopContacts } from '../api'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { useShop } from './AppLayout'
import { Toast } from './Toast'

type Key = keyof ShopContacts

// Проверка формата — те же правила, что у сервера (contacts_validate.go):
// при уходе с поля и при «Сохранить» (макет 16 · «Ошибка формата»).
// Существование аккаунтов не проверяем.
function checkTelegram(v: string): string {
  if (/^\+\d{10,15}$/.test(v.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, ''))) return ''
  const nick = v.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/\/$/, '')
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(nick)) return 'Только латиница, цифры и _, ник начинается с буквы'
  if (nick.length < 4 || nick.length > 32) return 'Ник — от 4 до 32 символов'
  return ''
}

function checkWhatsApp(v: string): string {
  const digits = v.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) return 'Номер с кодом страны: 7…, а не 8…'
  if (digits.length < 10 || digits.length > 15) return 'Только цифры: код страны и номер, например 79991234567'
  return ''
}

const HOSTS: Record<'vk' | 'max', string[]> = {
  vk: ['vk.me', 'vk.com', 'm.vk.com'],
  max: ['max.ru', 'm.max.ru'],
}

function checkHandle(channel: 'vk' | 'max', v: string): string {
  const msg = channel === 'vk' ? 'Ник латиницей или ссылка на vk.com' : 'Ник латиницей или ссылка на max.ru'
  if (!/^https?:\/\//i.test(v)) return /^@?[A-Za-z0-9_.-]{2,64}$/.test(v) ? '' : msg
  try {
    return HOSTS[channel].includes(new URL(v).hostname.toLowerCase()) ? '' : msg
  } catch {
    return msg
  }
}

function checkAvito(v: string): string {
  return /^(?:https?:\/\/)?(?:www\.|m\.)?avito\.ru\/(?:user|brands)\/[A-Za-z0-9_.-]+(?:[/?#]\S*)?$/i.test(v)
    ? ''
    : 'Только ссылка на профиль или магазин: avito.ru/user/… или avito.ru/brands/…'
}

// Каналы в том же порядке, в каком витрина рисует кнопки покупателю.
const CHANNELS: { key: Key; label: string; placeholder: string; hint: string; check: (v: string) => string }[] = [
  { key: 'telegram', label: 'Telegram', placeholder: 'Например, @seoulwear', hint: 'Можно ник, @ник или ссылку t.me/ник', check: checkTelegram },
  { key: 'whatsapp', label: 'WhatsApp', placeholder: 'Например, 79991234567', hint: 'Только цифры, без плюса и пробелов', check: checkWhatsApp },
  { key: 'vk', label: 'VK', placeholder: 'Например, vk.com/seoulwear', hint: 'Предзаполнить текст сообщения VK не позволяет', check: (v) => checkHandle('vk', v) },
  { key: 'max', label: 'MAX', placeholder: 'Ник или ссылка на профиль', hint: '', check: (v) => checkHandle('max', v) },
  { key: 'avito', label: 'Авито', placeholder: 'Ссылка на профиль или магазин', hint: 'Только ссылка, например avito.ru/brands/ваш-магазин', check: checkAvito },
]

export function ContactsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: ['shop', shop.id], queryFn: () => api.getShop(shop.id) })

  const [draft, setDraft] = useState<ShopContacts | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Ошибки показываем после ухода с поля или попытки сохранить.
  const [touched, setTouched] = useState<Partial<Record<Key, boolean>>>({})
  const [toast, setToast] = useState(false)
  const contacts = draft ?? current.data?.contacts ?? {}
  const settings = current.data?.settings ?? {}
  const messageValue = message ?? settings.msg_template ?? ''

  const save = useMutation({
    mutationFn: async () => {
      if (draft !== null) {
        // Пробелы по краям — частая ошибка копирования ссылки.
        const clean = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, (v ?? '').trim()]))
        await api.updateContacts(shop.id, clean)
      }
      if (message !== null) await api.updateSettings(shop.id, { ...settings, msg_template: message.trim() })
    },
    onSuccess: () => {
      setDraft(null)
      setMessage(null)
      setTouched({})
      setToast(true)
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
    },
  })

  // Хуки до ранних return: иначе на втором рендере порядок хуков меняется
  // и страница падает целиком (React #310).
  const dirty = draft !== null || message !== null
  useUnsavedGuard(dirty)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(false), 3000)
    return () => clearTimeout(t)
  }, [toast])

  if (current.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (current.isError) return <p className="text-danger" role="alert">Не удалось загрузить контакты.</p>

  const value = (k: Key) => (contacts[k] ?? '').trim()
  const errors = Object.fromEntries(CHANNELS.map((c) => [c.key, value(c.key) ? c.check(value(c.key)) : ''])) as Record<Key, string>
  const filled = CHANNELS.filter((c) => value(c.key))
  // В превью — только каналы, которые на витрине действительно заработают.
  const shown = filled.filter((c) => !errors[c.key])
  const hasErrors = CHANNELS.some((c) => errors[c.key])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (hasErrors) {
      setTouched(Object.fromEntries(CHANNELS.map((c) => [c.key, true])))
      return
    }
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="ocs" noValidate>
      <div className="ocs__head">
        <h1>Контакты</h1>
        <p>
          Кнопки, по которым покупатель напишет вам с витрины. Заполните хотя бы один канал — без него каталог не
          приводит заявок, а значит не работает.
        </p>
      </div>

      {/* Плашка не исчезает при вводе, а меняет тон: иначе форма прыгает
          вверх под курсором ровно в тот момент, когда продавец целится
          в следующее поле. */}
      <div className={`alert ocs__alert ${filled.length === 0 ? 'alert--warn' : 'alert--info'}`}>
        {filled.length === 0
          ? 'Не заполнено ни одного канала — покупатели не смогут вам написать.'
          : `Каналов заполнено: ${filled.length}.`}
      </div>

      <div className="ocs__cols">
        <div className="ocs__form">
          {CHANNELS.map((c) => {
            const err = touched[c.key] ? errors[c.key] : ''
            return (
              <label key={c.key} className="ocs__field">
                <span>{c.label}</span>
                <input
                  className="ocs__inp"
                  value={contacts[c.key] ?? ''}
                  onChange={(e) => setDraft({ ...contacts, [c.key]: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, [c.key]: true }))}
                  placeholder={c.placeholder}
                  maxLength={200}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `err-${c.key}` : undefined}
                />
                {err ? (
                  <span className="field__err" id={`err-${c.key}`} role="alert">
                    {err}
                  </span>
                ) : (
                  c.hint && <small>{c.hint}</small>
                )}
              </label>
            )
          })}

          <label className="ocs__field">
            <span>Текст сообщения</span>
            <textarea
              className="ocs__inp"
              rows={3}
              value={messageValue}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Например: Здравствуйте! Интересует товар с вашей витрины"
              maxLength={200}
            />
            <small>
              Этот текст автоматически подставится в сообщение, когда покупатель перейдёт с витрины по кнопке любого
              мессенджера (кроме VK и Авито).
            </small>
          </label>

          <button type="submit" className="btn btn--primary btn--pill ocs__save" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {/* Причину называем: «Не удалось сохранить» на номере через 8
              оставляло продавца гадать, что не так с «правильным» номером. */}
          {save.isError && (
            <p className="hint hint--err" role="alert">
              {errorText(save.error)}
            </p>
          )}
        </div>

        <div className="ocs__card ocs__preview">
          <h2>Как увидит покупатель</h2>
          {shown.length === 0 ? (
            <p className="ocs__empty">Кнопки появятся, когда вы заполните хотя бы один канал</p>
          ) : (
            <>
              <div className="ocs__btns">
                {shown.map((c) => (
                  <span key={c.key} className={`btn-${c.key}`}>
                    {c.label}
                  </span>
                ))}
              </div>
              <p className="ocs__lead">
                Покупатель нажмёт кнопку — откроется чат с вами, а в поле ввода уже будет текст сообщения. В VK текст
                не подставляется, Авито откроет ваш профиль.
              </p>
            </>
          )}
        </div>
      </div>

      {toast && (
        <div className="ocs__toast">
          <Toast text="Изменения сохранены" onClose={() => setToast(false)} />
        </div>
      )}
    </form>
  )
}
