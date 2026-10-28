import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { api, ApiError, errorText, type Shop, type ShopSettings, type User } from '../api'
import { Icon } from '../lib/icons'
import { Portal } from '../lib/Portal'
import { useDialogClose } from '../lib/useDialogClose'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { shopInitials, useShop } from './AppLayout'
import { EMAIL_RE, useAuthOptions, useCooldown, VKLogo, YandexLogo } from './AuthShell'
import { Toast } from './Toast'
import { WatermarkPaidHint } from './WatermarkControl'

// Настройки по макету 17: «Витрина» (то, что видят покупатели),
// «Водяной знак» (заметность и цвет — сам знак и положение выбираются
// у альбома), «Личные данные» (почта, телефон, пароль, вход через соцсети)
// и «Удалить аккаунт». «Сохранить» сохраняет всё, кроме пароля и логотипа:
// у них свои кнопки.

// Цвета знака (макет 17): белый, чёрный, серый или свой.
const WM_COLORS = [
  { hex: '#FFFFFF', name: 'Белый' },
  { hex: '#1A1A18', name: 'Чёрный' },
  { hex: '#90908A', name: 'Серый' },
]

const PROVIDER_NAMES = { yandex: 'Яндекс', vk: 'VK' } as const
type Provider = keyof typeof PROVIDER_NAMES

export function SettingsPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: ['shop', shop.id], queryFn: () => api.getShop(shop.id) })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })

  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [emailPassword, setEmailPassword] = useState('')
  const [phone, setPhone] = useState<string | null>(null)
  // Вернулись после «Подключить» Яндекс/VK: ?oauth_linked= или ?oauth_error=.
  const [oauthBack] = useState(() => new URLSearchParams(location.search))
  const [error, setError] = useState(() =>
    oauthBack.get('oauth_error') === 'taken'
      ? 'Этот аккаунт уже подключён к другой витрине'
      : oauthBack.get('oauth_error')
        ? 'Не удалось подключить вход — попробуйте ещё раз'
        : '',
  )
  const [toast, setToast] = useState(() => {
    const p = oauthBack.get('oauth_linked') as Provider | null
    return p && PROVIDER_NAMES[p] ? `${PROVIDER_NAMES[p]} подключён` : ''
  })
  const [deleting, setDeleting] = useState(false)

  const data = current.data
  const user = me.data
  const nameValue = name ?? data?.name ?? ''
  const descValue = description ?? data?.description ?? ''
  const slugValue = slug ?? data?.slug ?? ''
  const settingsValue = settings ?? data?.settings ?? {}
  const wm: NonNullable<ShopSettings['watermark']> = settingsValue.watermark ?? { enabled: false, text: '', opacity: 0.55 }
  const emailValue = email ?? user?.pending_email ?? user?.email ?? ''
  const phoneValue = phone ?? user?.phone ?? ''

  // Почту меняем только если её правда изменили: поле показывает и ждущую
  // подтверждения, и текущую.
  const emailChanged = email !== null && email.trim().toLowerCase() !== (user?.pending_email ?? user?.email ?? '').toLowerCase()
  const emailError = emailChanged && email.trim() && !EMAIL_RE.test(email.trim()) ? 'Проверьте адрес почты — похоже, в нём ошибка' : ''
  // Сменить почту аккаунта с паролем можно только зная его: открытая на
  // чужом компьютере сессия не должна уводить аккаунт на свою почту.
  const needEmailPassword = emailChanged && user?.has_password !== false

  const dirty = name !== null || description !== null || slug !== null || settings !== null || emailChanged || phone !== null
  useUnsavedGuard(dirty)
  const slugLocked = Boolean(data?.slug_changeable_at)
  // Смена адреса ломает все ссылки, которые продавец уже разослал, — просим
  // подтвердить последствие явно (макет 17 · «Смена адреса»).
  const slugNorm = slugValue.trim().toLowerCase()
  const slugChanged = slug !== null && slugNorm !== data?.slug
  const [slugConfirmed, setSlugConfirmed] = useState(false)
  const slugFormatError =
    slugChanged && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugNorm)
      ? 'Только латиница, цифры и одиночные дефисы между ними'
      : slugChanged && (slugNorm.length < 3 || slugNorm.length > 63)
        ? 'От 3 до 63 символов'
        : ''
  // Занятость проверяем при вводе (макет 17 · «Адрес занят») и при сохранении.
  const [slugTaken, setSlugTaken] = useState('')
  const [slugServerError, setSlugServerError] = useState('')
  useEffect(() => {
    if (!slugChanged || slugFormatError) return
    let alive = true
    const t = setTimeout(() => {
      api
        .checkSlug(slugNorm)
        .then((r) => {
          if (!alive) return
          setSlugTaken(r.available ? '' : r.error === 'slug_reserved' ? 'reserved' : 'taken')
        })
        .catch(() => {})
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [slugChanged, slugFormatError, slugNorm])
  const host = location.host
  const slugError =
    slugFormatError ||
    (slugChanged && slugTaken === 'taken' ? `Адрес ${host}/${slugNorm} уже занят — придумайте другой` : '') ||
    (slugChanged && slugTaken === 'reserved' ? 'Этот адрес занят служебными страницами сервиса — придумайте другой' : '') ||
    slugServerError

  useEffect(() => {
    if (oauthBack.has('oauth_linked') || oauthBack.has('oauth_error'))
      history.replaceState(null, '', location.pathname + location.hash)
  }, [oauthBack])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // Из меню «Настройки аккаунта» и «Быстрого доступа» приходят с #account /
  // #watermark, но блоки появляются после загрузки — роутер к ним уже не
  // прокручивает.
  const loaded = Boolean(data && user)
  useEffect(() => {
    if (loaded && /^#(account|watermark)$/.test(location.hash)) document.querySelector(location.hash)?.scrollIntoView({ block: 'start' })
  }, [loaded])

  const save = useMutation({
    mutationFn: async () => {
      if (settings !== null) await api.updateSettings(shop.id, settingsValue)
      if (name !== null || description !== null || slug !== null) {
        await api.updateShop(shop.id, {
          ...(name !== null ? { name: nameValue.trim() } : {}),
          ...(description !== null ? { description: descValue } : {}),
          ...(slugChanged ? { slug: slugNorm } : {}),
        })
      }
      if (phone !== null) await api.updateMe({ phone: phone.trim() })
      if (emailChanged) await api.changeEmail(email.trim(), emailPassword)
    },
    onSuccess: () => {
      setName(null)
      setDescription(null)
      setSlug(null)
      setSettings(null)
      setEmail(null)
      setEmailPassword('')
      setPhone(null)
      setSlugConfirmed(false)
      setError('')
      setToast(emailChanged ? 'Изменения сохранены. Письмо для подтверждения почты отправлено' : 'Изменения сохранены')
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && /^(slug_|invalid_slug)/.test(e.code)) {
        setSlugServerError(errorText(e))
        setError('')
      } else setError(errorText(e))
      // Что успело сохраниться — подтянем, чтобы форма не врала.
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })

  if (current.isPending || me.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (current.isError || me.isError || !data || !user) return <p className="text-danger" role="alert">Не удалось загрузить настройки.</p>

  const free = shop.plan === 'free'
  const patchWm = (next: Partial<typeof wm>) => setSettings({ ...settingsValue, watermark: { ...wm, ...next } })
  const wmColor = (wm.color ?? '#FFFFFF').toUpperCase()
  const preset = WM_COLORS.find((c) => c.hex === wmColor)

  const blocked =
    !dirty ||
    save.isPending ||
    (slugChanged && (!slugConfirmed || Boolean(slugError))) ||
    Boolean(emailError) ||
    (needEmailPassword && !emailPassword)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!blocked) save.mutate()
  }

  return (
    <div className="ocs ocs--narrow">
      <div className="ocs__head">
        <h1>Настройки</h1>
        <p>Как витрина выглядит для покупателей и данные вашего аккаунта.</p>
      </div>

      <form onSubmit={submit} className="ocs__stack" noValidate>
        <section className="ocs__card">
          <div className="ocs__cardhead">
            <h2>Витрина</h2>
            <p>То, что видят покупатели: адрес, название и шапка витрины.</p>
          </div>

          <LogoField shop={shop} logoUrl={data.logo_url} />

          <label className="ocs__field">
            <span>Адрес витрины</span>
            <input
              className="ocs__inp"
              value={slugValue}
              onChange={(e) => {
                setSlug(e.target.value)
                setSlugTaken('')
                setSlugServerError('')
              }}
              disabled={slugLocked}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={slugError ? 'slug-err' : undefined}
            />
            {slugError ? (
              <span className="field__err" role="alert" id="slug-err">
                {slugError}
              </span>
            ) : (
              <small>
                {host}/{slugValue || 'адрес'} — эту ссылку вы отправляете покупателям.
                {slugLocked &&
                  ` Менять можно не чаще раза в полгода: следующая смена после ${new Date(data.slug_changeable_at!).toLocaleDateString('ru-RU')}.`}
              </small>
            )}
          </label>

          {slugChanged && !slugError && (
            <div className="alert alert--warn ocs__alert">
              <span className="flex-1">
                Адрес станет {host}/{slugNorm || '…'}. Все ранее разосланные ссылки на {host}/{data.slug} перестанут
                работать, включая те, что уже лежат в переписках с покупателями.
                <label className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={slugConfirmed} onChange={(e) => setSlugConfirmed(e.target.checked)} />
                  Понимаю, меняем адрес
                </label>
              </span>
            </div>
          )}

          <label className="ocs__field">
            <span>Название витрины</span>
            <input className="ocs__inp" value={nameValue} onChange={(e) => setName(e.target.value)} maxLength={200} />
            <small>Показывается в шапке витрины и в превью ссылки.</small>
          </label>

          <label className="ocs__field">
            <span>Описание</span>
            <textarea className="ocs__inp" rows={3} value={descValue} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
            <small>Короткий текст под названием магазина на витрине.</small>
          </label>
        </section>

        <section className="ocs__card" id="watermark">
          <div className="ocs__cardhead">
            <h2>Водяной знак</h2>
            <p>
              Как знак будет выглядеть на фото. Включить его можно при создании альбома или при загрузке фото. Уже
              загруженные фото не меняются.
            </p>
          </div>
          {/* Бесплатный (макет 17 · «Free-тариф»): блок неактивен, под
              заголовком — подсказка со сменой тарифа. */}
          {free && <WatermarkPaidHint />}
          <fieldset disabled={free} className="ocs__wm">
            <label className="ocs__field">
              <span>Заметность: {Math.round(wm.opacity * 100)}%</span>
              <input
                type="range"
                className="ocs__range"
                min={10}
                max={100}
                value={Math.round(wm.opacity * 100)}
                onChange={(e) => patchWm({ opacity: Number(e.target.value) / 100 })}
                style={{ '--val': `${((Math.round(wm.opacity * 100) - 10) / 90) * 100}%` } as CSSProperties}
              />
            </label>
            <div className="ocs__field">
              <span id="wm-color">Цвет</span>
              <div className="ocs__swatches" role="radiogroup" aria-labelledby="wm-color">
                {WM_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    type="button"
                    role="radio"
                    aria-checked={wmColor === c.hex}
                    aria-label={c.name}
                    className="ocs__swatch"
                    style={{ background: c.hex }}
                    onClick={() => patchWm({ color: c.hex })}
                  />
                ))}
                {/* «Свой» — системная палитра браузера. */}
                <label
                  className="ocs__swatch ocs__swatch--own"
                  aria-checked={!preset}
                  style={preset ? undefined : { background: wmColor }}
                  title="Свой цвет"
                >
                  <input
                    type="color"
                    value={wmColor.toLowerCase()}
                    onChange={(e) => patchWm({ color: e.target.value.toUpperCase() })}
                    aria-label="Свой цвет"
                  />
                  {preset && '+'}
                </label>
                <b>{preset?.name ?? 'Свой'}</b>
              </div>
            </div>
          </fieldset>
        </section>

        <section className="ocs__card" id="account">
          <div className="ocs__cardhead">
            <h2>Личные данные</h2>
            <p>Видите только вы — покупателям эти данные не показываются.</p>
          </div>

          <EmailField
            user={user}
            value={emailValue}
            onChange={setEmail}
            error={emailError}
            onResent={() => setToast('Письмо отправлено ещё раз')}
          />
          {needEmailPassword && (
            <label className="ocs__field">
              <span>Текущий пароль</span>
              <input
                className="ocs__inp"
                type="password"
                autoComplete="current-password"
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
              />
              <small>Нужен, чтобы сменить почту для входа.</small>
            </label>
          )}

          <label className="ocs__field">
            <span>Телефон</span>
            <input
              className="ocs__inp"
              type="tel"
              autoComplete="tel"
              value={phoneValue}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 999 123-45-67"
              maxLength={24}
            />
            <small>Для связи по вопросам аккаунта.</small>
          </label>

          {user.has_password !== false ? (
            <>
              <PasswordBlock user={user} onDone={setToast} />
              <SocialBlock user={user} />
            </>
          ) : (
            <>
              <SocialBlock user={user} />
              <PasswordBlock user={user} onDone={setToast} />
            </>
          )}
        </section>

        {error && (
          <p className="hint hint--err" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn--primary btn--pill ocs__save" disabled={blocked}>
            {save.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </form>

      <section className="ocs__card ocs__stack-gap">
        <div className="ocs__cardhead">
          <h2>Удалить аккаунт</h2>
          <p>Витрина, альбомы и все фото удалятся навсегда, ссылки перестанут работать. Отменить это нельзя.</p>
        </div>
        <div>
          <button type="button" className="ocs__danger" onClick={() => setDeleting(true)}>
            Удалить аккаунт
          </button>
        </div>
      </section>

      {deleting && <DeleteAccountDialog shop={shop} user={user} onClose={() => setDeleting(false)} />}
      {toast && (
        <div className="ocs__toast">
          <Toast text={toast} onClose={() => setToast('')} />
        </div>
      )}
    </div>
  )
}

// Логотип (макет 17): загружается сразу, своей кнопкой. Файл уходит прямо
// в хранилище, сервер проверяет его как фото и делает WebP; ждём готовности.
function LogoField({ shop, logoUrl }: { shop: Shop; logoUrl?: string }) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const upload = async (file: File) => {
    setErr('')
    if (!/^image\/(jpeg|png)$/.test(file.type)) return setErr('Нужен JPG или PNG')
    const size = await imageSize(file)
    if (size && (size.w < 200 || size.h < 200)) return setErr('Картинка меньше 200×200 — в шапке витрины она будет размытой')
    setBusy(true)
    try {
      const pre = await api.presignLogo(shop.id)
      const put = await fetch(pre.url, { method: 'PUT', body: file })
      if (!put.ok) throw new Error('Не удалось загрузить файл — попробуйте ещё раз')
      await api.confirmLogo(shop.id, pre.logo_id)
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const st = await api.logoStatus(shop.id, pre.logo_id)
        if (st.status === 'ready') break
        if (st.status === 'failed')
          throw new Error(st.reason === 'too_small' ? 'Картинка меньше 200×200 — нужна побольше' : 'Файл не подошёл — нужен JPG или PNG')
        if (i === 59) throw new Error('Логотип обрабатывается дольше обычного — обновите страницу через минуту')
      }
      await queryClient.invalidateQueries({ queryKey: ['shop', shop.id] })
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = useMutation({
    mutationFn: () => api.deleteLogo(shop.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] }),
    onError: (e) => setErr(errorText(e)),
  })

  return (
    <div className="ocs__field">
      <span>Логотип</span>
      <div className="ocs__logo">
        <i aria-hidden="true">{logoUrl ? <img src={logoUrl} alt="" /> : shopInitials(shop.name)}</i>
        <div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ocs__ghost" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Загружаю…' : logoUrl ? 'Заменить логотип' : 'Загрузить логотип'}
            </button>
            {logoUrl && !busy && (
              <button type="button" className="ocs__ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Убрать
              </button>
            )}
          </div>
          {err ? (
            <span className="field__err" role="alert">
              {err}
            </span>
          ) : (
            <small>JPG или PNG, квадрат от 200×200. Без логотипа в шапке витрины — инициалы.</small>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void upload(f)
          }}
        />
      </div>
    </div>
  )
}

function imageSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

// Почта (макет 17): смена — письмо на новую почту; до перехода по ссылке
// она «Не подтверждена», письмо можно отправить ещё раз через 60 секунд.
function EmailField({
  user,
  value,
  onChange,
  error,
  onResent,
}: {
  user: User
  value: string
  onChange: (v: string) => void
  error: string
  onResent: () => void
}) {
  const pending = user.pending_email
  const [left, restart] = useCooldown(pending ? 60 : 0)
  const resend = useMutation({
    mutationFn: api.resendEmailChange,
    onSuccess: () => {
      restart()
      onResent()
    },
  })
  return (
    <label className="ocs__field">
      <span>Почта</span>
      <span className="ocs__inpwrap">
        <input
          className="ocs__inp"
          type="email"
          autoComplete="email"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Добавьте почту"
          aria-invalid={error ? true : undefined}
        />
        {pending && value === pending && <em className="ocs__badge">Не подтверждена</em>}
      </span>
      {error ? (
        <span className="field__err" role="alert">
          {error}
        </span>
      ) : pending ? (
        <small>
          Письмо отправлено на {pending} — перейдите по ссылке в нём.{' '}
          <button
            type="button"
            className="ocs__link"
            disabled={left > 0 || resend.isPending}
            onClick={(e) => {
              e.preventDefault()
              resend.mutate()
            }}
          >
            {left > 0 ? `Отправить ещё раз через 0:${String(left).padStart(2, '0')}` : 'Отправить ещё раз'}
          </button>
          {resend.isError && <> {errorText(resend.error)}</>}
        </small>
      ) : user.email ? (
        <small>Для входа в кабинет. После смены пришлём письмо для подтверждения на новую почту.</small>
      ) : (
        <small>Нужна для чеков об оплате и уведомлений. После сохранения пришлём письмо для подтверждения.</small>
      )}
    </label>
  )
}

// Пароль: смена (аккаунт по почте) или «Задать пароль» (аккаунт через
// Яндекс/VK — пароль нужен для удаления аккаунта и входа без соцсети).
// Своя кнопка: «Сохранить» пароль не трогает. Не вложенная форма — она
// внутри общей.
function PasswordBlock({ user, onDone }: { user: User; onDone: (t: string) => void }) {
  const queryClient = useQueryClient()
  const has = user.has_password !== false
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () => (has ? api.changePassword(cur, next) : api.setPassword(next)),
    onSuccess: () => {
      setCur('')
      setNext('')
      onDone(has ? 'Пароль изменён' : 'Пароль задан')
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })
  const tooShort = [...next].length < 8
  const via = PROVIDER_NAMES[(user.identities?.[0]?.provider ?? 'yandex') as Provider]
  return (
    <div className="ocs__sub">
      <h3>{has ? 'Смена пароля' : 'Пароль'}</h3>
      {!has && (
        <small className="ocs__subtext">
          Пароль нужен, даже если вы входите через {via}: им подтверждается удаление аккаунта, а вместе с почтой он
          позволит войти, если {via} будет недоступен.
        </small>
      )}
      {has && (
        <label className="ocs__field">
          <span>Текущий пароль</span>
          <input
            className="ocs__inp"
            type="password"
            autoComplete="current-password"
            value={cur}
            onChange={(e) => {
              setCur(e.target.value)
              change.reset()
            }}
          />
        </label>
      )}
      <label className="ocs__field">
        <span>Новый пароль</span>
        <input
          className="ocs__inp"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value)
            change.reset()
          }}
        />
        {change.isError ? (
          <span className="field__err" role="alert">
            {errorText(change.error)}
          </span>
        ) : (
          <small>{has ? 'Не короче 8 символов. Другие устройства выйдут из кабинета.' : 'Не короче 8 символов.'}</small>
        )}
      </label>
      <div>
        <button
          type="button"
          className="ocs__ghost"
          disabled={(has && !cur) || tooShort || change.isPending}
          onClick={() => change.mutate()}
        >
          {change.isPending ? 'Сохраняю…' : has ? 'Сменить пароль' : 'Задать пароль'}
        </button>
      </div>
    </div>
  )
}

// Вход через соцсети (макет 17): подключённые и доступные провайдеры.
// MAX публичного OAuth для сайтов не даёт — его строки нет (как и кнопки
// на экране входа, см. backend/internal/api/oauth.go).
function SocialBlock({ user }: { user: User }) {
  const options = useAuthOptions()
  const linked = new Map((user.identities ?? []).map((i) => [i.provider, i.label]))
  const providers = (['yandex', 'vk'] as Provider[]).filter((p) => linked.has(p) || options.data?.providers.includes(p))
  if (providers.length === 0) return null
  const createdVia = user.has_password === false ? user.identities?.[0]?.provider : undefined
  const others = providers.filter((p) => !linked.has(p)).map((p) => PROVIDER_NAMES[p])
  return (
    <div className="ocs__sub">
      <h3>Вход через соцсети</h3>
      <div className="ocs__socials">
        {providers.map((p) => (
          <div key={p} className="ocs__social">
            {p === 'yandex' ? <YandexLogo /> : <VKLogo />}
            <span>
              <b>{PROVIDER_NAMES[p]}</b>
              <small>{linked.has(p) ? (linked.get(p) ?? 'Подключён') : 'Не подключён'}</small>
            </span>
            {linked.has(p) ? (
              <em className="ocs__on">Подключён</em>
            ) : (
              <a className="ocs__ghost" href={`/api/v1/auth/oauth/${p}/start?link=1`}>
                Подключить
              </a>
            )}
          </div>
        ))}
      </div>
      <small>
        {createdVia
          ? `Аккаунт создан через ${PROVIDER_NAMES[createdVia as Provider]}.${others.length ? ` Подключите ${others.join(' или ')}, чтобы входить и через ${others.length > 1 ? 'них' : 'него'}.` : ''}`
          : 'Подключите, чтобы входить в этот аккаунт в одно нажатие. Вход по почте и паролю останется.'}
      </small>
    </div>
  )
}

// «Удалить аккаунт?» (макет 17): только с верным паролем; пока пароля нет
// (вход через Яндекс/VK) — подсказка задать его, кнопка неактивна.
function DeleteAccountDialog({ shop, user, onClose }: { shop: Shop; user: User; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const back = useDialogClose(onClose)
  const del = useMutation({
    mutationFn: () => api.deleteAccount(password),
    onSuccess: () => {
      queryClient.clear()
      location.assign('/')
    },
  })
  const has = user.has_password !== false
  return (
    <Portal>
      <div className="modal__back" role="alertdialog" aria-modal="true" aria-label="Удалить аккаунт?" {...back}>
        <form
          className="modal modal--sm ocs__modal"
          onSubmit={(e) => {
            e.preventDefault()
            if (has && password && !del.isPending) del.mutate()
          }}
        >
          <span className="ocs__modalico" aria-hidden="true">
            <Icon as={Trash2} size={20} />
          </span>
          <h2>Удалить аккаунт?</h2>
          <p>
            Витрина {location.host}/{shop.slug}, все альбомы и фото удалятся навсегда. Ссылки, которые вы отправляли
            покупателям, перестанут работать. Отменить это нельзя.
          </p>
          {has ? (
            <label className="ocs__field">
              <span>Введите пароль, чтобы подтвердить</span>
              <input
                className="ocs__inp"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  del.reset()
                }}
                aria-invalid={del.isError ? true : undefined}
              />
              {del.isError && (
                <span className="field__err" role="alert">
                  {errorText(del.error)}
                </span>
              )}
            </label>
          ) : (
            <p className="hint hint--i">Сначала задайте пароль в «Личных данных» — им подтверждается удаление аккаунта.</p>
          )}
          <div className="ocs__modalfoot">
            <button type="button" className="ocs__ghost" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn btn--danger btn--pill" disabled={!has || !password || del.isPending}>
              {del.isPending ? 'Удаляю…' : 'Удалить аккаунт'}
            </button>
          </div>
        </form>
      </div>
    </Portal>
  )
}
