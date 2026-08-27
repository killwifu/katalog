import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ApiError, api, type ShopSettings } from '../api'
import { useShop } from './AppLayout'

export function SettingsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: ['shop', shop.id], queryFn: () => api.getShop(shop.id) })

  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [error, setError] = useState('')

  const data = current.data
  const nameValue = name ?? data?.name ?? ''
  const descValue = description ?? data?.description ?? ''
  const slugValue = slug ?? data?.slug ?? ''
  const settingsValue = settings ?? data?.settings ?? {}
  const wm = settingsValue.watermark ?? { enabled: false, text: '', opacity: 0.55 }

  const dirty = name !== null || description !== null || slug !== null || settings !== null
  const slugLocked = Boolean(data?.slug_changeable_at)

  const save = useMutation({
    mutationFn: async () => {
      if (settings !== null) await api.updateSettings(shop.id, settingsValue)
      if (name !== null || description !== null || slug !== null) {
        await api.updateShop(shop.id, {
          ...(name !== null ? { name: nameValue.trim() } : {}),
          ...(description !== null ? { description: descValue } : {}),
          ...(slug !== null && slugValue !== data?.slug ? { slug: slugValue.trim().toLowerCase() } : {}),
        })
      }
    },
    onSuccess: () => {
      setName(null)
      setDescription(null)
      setSlug(null)
      setSettings(null)
      setError('')
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
    },
    onError: (e: Error) => {
      const messages: Record<string, string> = {
        slug_taken: 'Этот адрес уже занят',
        invalid_slug: 'Адрес: 3–63 символа, латиница, цифры и одиночные дефисы',
        invalid_name: 'Укажите название (до 200 символов)',
      }
      setError(e instanceof ApiError ? (messages[e.code] ?? e.message) : e.message)
    },
  })

  if (current.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (current.isError) return <p className="text-danger">Не удалось загрузить настройки.</p>

  const patchWm = (next: Partial<typeof wm>) =>
    setSettings({ ...settingsValue, watermark: { ...wm, ...next } })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="max-w-2xl">
      <div className="page__head">
        <h1>Настройки витрины</h1>
      </div>

      <section className="box">
        <h2>Адрес и название</h2>

        <label className="field">
          <span>Адрес витрины</span>
          <input
            className="inp"
            value={slugValue}
            onChange={(e) => setSlug(e.target.value)}
            disabled={slugLocked}
          />
          <p className="hint">
            {location.origin}/{slugValue || 'адрес'} — эту ссылку вы отправляете покупателям.
            {slugLocked
              ? ` Менять можно не чаще раза в полгода: следующая смена после ${new Date(
                  data!.slug_changeable_at!,
                ).toLocaleDateString('ru-RU')}.`
              : ' После смены старые ссылки перестанут работать.'}
          </p>
        </label>

        <label className="field">
          <span>Название витрины</span>
          <input
            className="inp"
            value={nameValue}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
          />
          <p className="hint">Показывается в шапке витрины и в превью ссылки.</p>
        </label>

        <label className="field !mb-0">
          <span>Описание</span>
          <textarea
            className="inp"
            rows={3}
            value={descValue}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="hint">Короткий текст под названием магазина на витрине.</p>
        </label>
      </section>

      <section className="box">
        <h2>Водяной знак</h2>
        <p className="hint !mt-0 mb-3">
          Накладывается при загрузке. Уже загруженные фотографии не меняются — чтобы
          применить знак к ним, их нужно загрузить заново.
        </p>

        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={wm.enabled}
            onChange={(e) => patchWm({ enabled: e.target.checked })}
          />
          Ставить знак на новые фотографии
        </label>

        <label className="field">
          <span>Текст</span>
          <input
            className="inp"
            value={wm.text}
            onChange={(e) => patchWm({ text: e.target.value })}
            placeholder="@ваш_ник"
            maxLength={40}
            disabled={!wm.enabled}
          />
        </label>

        <label className="field !mb-0">
          <span>Заметность: {Math.round(wm.opacity * 100)}%</span>
          <input
            type="range"
            min={10}
            max={100}
            value={Math.round(wm.opacity * 100)}
            onChange={(e) => patchWm({ opacity: Number(e.target.value) / 100 })}
            disabled={!wm.enabled}
            className="w-full"
          />
        </label>
      </section>

      <section className="box">
        <h2>Сообщение покупателя</h2>
        <p className="hint !mt-0 mb-3">
          Текст, который подставится в мессенджер. Доступна подстановка{' '}
          <code className="text-xs">{'{caption}'}</code>.
        </p>
        <input
          className="inp"
          value={settingsValue.msg_template ?? ''}
          onChange={(e) => setSettings({ ...settingsValue, msg_template: e.target.value })}
          placeholder="Здравствуйте! Интересует {caption}"
          maxLength={200}
        />
      </section>

      {error && <p className="hint text-danger">{error}</p>}
      <button type="submit" className="btn btn--primary btn--block-mobile" disabled={!dirty || save.isPending}>
        {save.isPending ? 'Сохраняю…' : 'Сохранить'}
      </button>
    </form>
  )
}
