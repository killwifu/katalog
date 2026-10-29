import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { api, API_ERRORS, ApiError, errorText } from '../api'
import { clearIntent, readIntent } from '../lib/signupIntent'
import { slugify } from './CategoriesPage'
import { AuthHead, AuthShell, Field } from './AuthShell'

// Макет 08 · «Создание витрины» — после подтверждения почты, один экран.
// Адрес проверяется сразу при вводе. После «Создать витрину»: на
// Бесплатном и пробном «Про» — сразу в кабинет, на платном тарифе с
// лендинга — оплата через ЮKassa за выбранный период, затем кабинет.
export function OnboardingPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [touched, setTouched] = useState(false)
  const [check, setCheck] = useState<{ slug: string; available: boolean; error?: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const host = location.host

  // Пока адрес не трогали руками, ведём его за названием: продавцу
  // не нужно думать про slug, но подправить его можно.
  const effectiveSlug = (touched ? slug : slugify(name)).trim().toLowerCase()

  useEffect(() => {
    if (!effectiveSlug) return
    let cancelled = false
    const t = setTimeout(() => {
      api.checkSlug(effectiveSlug).then(
        (r) => !cancelled && setCheck({ slug: effectiveSlug, ...r }),
        () => {},
      )
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [effectiveSlug])

  const current = check && check.slug === effectiveSlug ? check : null
  const slugError = !effectiveSlug
    ? ''
    : current && !current.available
      ? current.error === 'slug_taken'
        ? `Адрес ${host}/${effectiveSlug} уже занят — придумайте другой`
        : (API_ERRORS[current.error ?? ''] ?? 'Адрес не подходит')
      : ''

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: ['shops'] })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    // Адрес занят — кнопка не срабатывает, пока его не изменят (заметка макета).
    if (slugError || busy) return
    if (!name.trim()) {
      setError('Укажите название')
      return
    }
    setError('')
    setBusy(true)
    try {
      // Кабинет ведёт один магазин на аккаунт: онбординг во второй вкладке
      // не должен заводить второй.
      const [existing] = await api.listShops()
      const shop = existing ?? (await api.createShop(effectiveSlug, name.trim()))
      const intent = readIntent()
      clearIntent()
      if (intent.trial) {
        // Пробный «Про» уже использован или недоступен — витрина всё равно создана.
        await api.startTrial(shop.id).catch(() => {})
      } else if (intent.plan) {
        try {
          const r = await api.subscribe(shop.id, intent.plan, intent.period ?? 'month')
          if (r.confirmation_url) {
            location.assign(r.confirmation_url)
            return
          }
        } catch {
          // Оплата сейчас недоступна — тариф выберут в «Подписке».
          await finish()
          void navigate({ to: '/billing' })
          return
        }
      }
      await finish()
    } catch (err) {
      if (err instanceof ApiError && ['slug_taken', 'invalid_slug', 'slug_reserved'].includes(err.code)) {
        setCheck({ slug: effectiveSlug, available: false, error: err.code })
      } else {
        setError(errorText(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <form onSubmit={(e) => void submit(e)} noValidate className="au__form">
        <AuthHead title="Создание витрины" lead="Название и адрес можно поменять позже в настройках" />
        <div className="au__fields">
          <Field
            label="Название витрины"
            autoFocus
            value={name}
            error={error}
            hint="Показывается в шапке витрины и в превью ссылки"
            maxLength={200}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
          />
          <Field
            label="Адрес витрины"
            prefix={`${host}/`}
            value={effectiveSlug}
            autoCapitalize="none"
            spellCheck={false}
            error={slugError}
            ok={current?.available ? 'Адрес свободен — эту ссылку вы будете отправлять покупателям' : undefined}
            onChange={(e) => {
              setTouched(true)
              setSlug(e.target.value)
            }}
          />
        </div>
        <button type="submit" className="btn btn--primary au-btn" disabled={busy}>
          Создать витрину
        </button>
      </form>
    </AuthShell>
  )
}
