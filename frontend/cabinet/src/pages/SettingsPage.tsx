import { CircleCheck } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, type ShopSettings, errorText } from '../api'
import { Icon } from '../lib/icons'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { WATERMARK_POSITIONS } from '../lib/watermark'
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
  const wm: NonNullable<ShopSettings['watermark']> = settingsValue.watermark ?? { enabled: false, text: '', opacity: 0.55 }

  const dirty = name !== null || description !== null || slug !== null || settings !== null
  useUnsavedGuard(dirty)
  const slugLocked = Boolean(data?.slug_changeable_at)
  // Смена адреса ломает все ссылки, которые продавец уже разослал, и уезжает
  // на сервер той же кнопкой, что описание и водяной знак. Одного «Сохранить»
  // для такого мало — просим подтвердить последствие явно.
  const slugChanged = slug !== null && slugValue.trim().toLowerCase() !== data?.slug
  const [slugConfirmed, setSlugConfirmed] = useState(false)
  // Формат адреса проверяем сразу (те же правила, что у сервера): иначе
  // «Адрес станет …/плохой адрес» обещал невозможное, а отказ приходил
  // только после «Сохранить» строкой внизу страницы.
  const slugFormatError =
    slugChanged && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugValue.trim().toLowerCase())
      ? 'Только латиница, цифры и одиночные дефисы между ними'
      : slugChanged && (slugValue.trim().length < 3 || slugValue.trim().length > 63)
        ? 'От 3 до 63 символов'
        : ''
  // Отказ сервера по адресу (занят, служебный) — у поля адреса.
  const [slugServerError, setSlugServerError] = useState('')
  const slugError = slugFormatError || slugServerError

  const save = useMutation({
    mutationFn: async () => {
      if (settings !== null) await api.updateSettings(shop.id, settingsValue)
      if (name !== null || description !== null || slug !== null) {
        await api.updateShop(shop.id, {
          ...(name !== null ? { name: nameValue.trim() } : {}),
          ...(description !== null ? { description: descValue } : {}),
          ...(slugChanged ? { slug: slugValue.trim().toLowerCase() } : {}),
        })
      }
    },
    onSuccess: () => {
      setName(null)
      setDescription(null)
      setSlug(null)
      setSettings(null)
      setSlugConfirmed(false)
      setError('')
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && /^(slug_|invalid_slug)/.test(e.code)) {
        setSlugServerError(errorText(e))
        setError('')
      } else setError(errorText(e))
    },
  })

  if (current.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (current.isError) return <p className="text-danger" role="alert">Не удалось загрузить настройки.</p>

  const patchWm = (next: Partial<typeof wm>) =>
    setSettings({ ...settingsValue, watermark: { ...wm, ...next } })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Смена адреса — только с явным подтверждением, даже если форму
    // отправили не кнопкой.
    if (slugChanged && (!slugConfirmed || slugError)) return
    save.mutate()
  }

  return (
    <>
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
              onChange={(e) => {
                setSlug(e.target.value)
                setSlugServerError('')
              }}
              disabled={slugLocked}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={slugError ? 'slug-err' : undefined}
            />
            {slugError && <p className="field__err" role="alert" id="slug-err">{slugError}</p>}
            <p className="hint">
              {location.origin}/{slugValue || 'адрес'} — эту ссылку вы отправляете покупателям.
              {slugLocked &&
                ` Менять можно не чаще раза в полгода: следующая смена после ${new Date(
                  data!.slug_changeable_at!,
                ).toLocaleDateString('ru-RU')}.`}
            </p>
          </label>

          {slugChanged && !slugError && (
            <div className="alert alert--warn">
              <span className="flex-1">
                Адрес станет {location.origin}/{slugValue.trim().toLowerCase() || '…'}. Все ранее
                разосланные ссылки на {location.origin}/{data?.slug} перестанут работать, включая
                те, что уже лежат в переписках с покупателями.
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={slugConfirmed}
                    onChange={(e) => setSlugConfirmed(e.target.checked)}
                  />
                  Понимаю, меняем адрес
                </label>
              </span>
            </div>
          )}

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

        <section className="box" id="watermark">
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

          <label className="field">
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

          <div className="field">
            <span>Положение на фото</span>
            <div className="wmgrid" role="radiogroup" aria-label="Положение водяного знака" style={{ width: 'fit-content' }}>
              {WATERMARK_POSITIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={(wm.position ?? 'br') === p.id}
                  aria-label={p.label}
                  title={p.label}
                  disabled={!wm.enabled}
                  onClick={() => patchWm({ position: p.id })}
                />
              ))}
            </div>
          </div>

          {/* Знак впекается при загрузке и на уже загруженных фото не меняется.
              Узнавать, что 55% — это много, на трёхстах снимках поздно. */}
          <div className="field !mb-0">
            <span>Как будет выглядеть</span>
            <div className={`wmprev wmprev--${wm.position ?? 'br'}`}>
              <span style={{ opacity: wm.enabled ? wm.opacity : 0.15 }}>
                {wm.text || '@ваш_ник'}
              </span>
            </div>
          </div>
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

        {error && <p className="hint hint--err" role="alert">{error}</p>}
        <button
          type="submit"
          className="btn btn--primary btn--block-mobile"
          disabled={!dirty || save.isPending || (slugChanged && (!slugConfirmed || Boolean(slugError)))}
        >
          {save.isPending ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {save.isSuccess && !dirty && (
          <p className="hint text-[#1B6B3A]" role="status">
            <Icon as={CircleCheck} />
            Сохранено
          </p>
        )}
      </form>
      <AccountSection />
    </>
  )
}

// Аккаунт: почта и смена пароля. Пункт меню «Настройки аккаунта» вёл
// сюда, а сменить пароль можно было только через «Забыли пароль» —
// выйдя из кабинета и дождавшись письма. Отдельная форма: страница
// выше — одна общая форма витрины.
function AccountSection() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('')
      setNext('')
    },
  })
  const tooShort = [...next].length < 8
  // Из меню «Настройки аккаунта» приходят с #account, но блок появляется
  // только после загрузки настроек — роутер к нему уже не прокручивает.
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    if (location.hash === '#account') box.current?.scrollIntoView({ block: 'start' })
  }, [])
  return (
    <section ref={box} className="box mt-6 max-w-2xl" id="account">
      <h2>Аккаунт</h2>
      {me.data?.email && <p className="mb-3 text-sm text-ink-2">Почта для входа: {me.data.email}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!current || tooShort || change.isPending) return
          change.mutate()
        }}
      >
        <label className="field">
          <span>Текущий пароль</span>
          <input
            className="inp"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              change.reset()
            }}
          />
        </label>
        <label className="field">
          <span>Новый пароль</span>
          <input
            className="inp"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
              change.reset()
            }}
          />
          <p className="hint">Не короче 8 символов. Другие устройства выйдут из кабинета.</p>
        </label>
        {change.isError && <p className="hint text-danger" role="alert">{errorText(change.error)}</p>}
        <button type="submit" className="btn btn--ghost" disabled={!current || tooShort || change.isPending}>
          {change.isPending ? 'Меняю…' : 'Сменить пароль'}
        </button>
        {change.isSuccess && (
          <p className="hint text-[#1B6B3A]" role="status">
            <Icon as={CircleCheck} />
            Пароль изменён
          </p>
        )}
      </form>
    </section>
  )
}
