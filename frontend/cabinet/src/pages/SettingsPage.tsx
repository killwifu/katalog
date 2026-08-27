import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type ShopSettings } from '../api'
import { useShop } from './AppLayout'

export function SettingsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: ['shop', shop.id], queryFn: () => api.getShop(shop.id) })

  const [draft, setDraft] = useState<ShopSettings | null>(null)
  const settings = draft ?? current.data?.settings ?? {}
  const wm = settings.watermark ?? { enabled: false, text: '', opacity: 0.55 }

  const save = useMutation({
    mutationFn: () => api.updateSettings(shop.id, settings),
    onSuccess: () => {
      setDraft(null)
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
    },
  })

  if (current.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (current.isError) return <p className="text-danger">Не удалось загрузить настройки.</p>

  const patch = (next: Partial<ShopSettings>) => setDraft({ ...settings, ...next })
  const patchWm = (next: Partial<typeof wm>) => patch({ watermark: { ...wm, ...next } })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="max-w-xl">
      <div className="page__head">
        <h1>Настройки</h1>
      </div>

      <section className="mb-6 rounded border border-line p-4">
        <h2 className="mb-1 text-sm font-medium text-ink">Водяной знак</h2>
        <p className="mb-3 text-sm text-ink-2">
          Накладывается при загрузке. Уже загруженные фотографии не меняются — чтобы
          применить знак к ним, их нужно загрузить заново.
        </p>

        <label className="mb-3 flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={wm.enabled}
            onChange={(e) => patchWm({ enabled: e.target.checked })}
          />
          Ставить знак на новые фотографии
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-ink-2">Текст</span>
          <input
            value={wm.text}
            onChange={(e) => patchWm({ text: e.target.value })}
            placeholder="@ваш_ник"
            maxLength={40}
            disabled={!wm.enabled}
            className="inp w-full disabled:bg-surface-alt"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm text-ink-2">
            Заметность: {Math.round(wm.opacity * 100)}%
          </span>
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

      <section className="mb-6 rounded border border-line p-4">
        <h2 className="mb-1 text-sm font-medium text-ink">Сообщение покупателя</h2>
        <p className="mb-3 text-sm text-ink-2">
          Текст, который подставится в мессенджер. Доступна подстановка{' '}
          <code className="text-xs">{'{caption}'}</code>.
        </p>
        <input
          value={settings.msg_template ?? ''}
          onChange={(e) => patch({ msg_template: e.target.value })}
          placeholder="Здравствуйте! Интересует {caption}"
          maxLength={200}
          className="inp w-full"
        />
      </section>

      <button
        type="submit"
        disabled={draft === null || save.isPending}
        className="btn btn--primary"
      >
        {save.isPending ? 'Сохраняю…' : 'Сохранить'}
      </button>
      {save.isError && <p className="mt-2 text-sm text-danger">Не удалось сохранить.</p>}
    </form>
  )
}
