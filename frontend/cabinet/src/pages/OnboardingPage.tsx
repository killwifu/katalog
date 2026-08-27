import { useQueryClient } from '@tanstack/react-query'
import AwsS3 from '@uppy/aws-s3'
import Uppy from '@uppy/core'
import ru_RU from '@uppy/locales/lib/ru_RU'
import { Dashboard } from '@uppy/react'
import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type Shop } from '../api'
import { slugify } from './CategoriesPage'
import '@uppy/core/dist/style.min.css'
import '@uppy/dashboard/dist/style.min.css'

// Онбординг — ровно три шага (kit). Больше человек не пройдёт, а цель здесь
// не «зарегистрировать», а довести до первой отправленной ссылки: именно она
// запускает и продажи, и вирусный канал. Категории, оформление и описания
// отложены в кабинет, где о них напоминает блок «Стоит доделать».
export function OnboardingPage() {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [shop, setShop] = useState<Shop | null>(null)

  return (
    <div className="ob">
      <Steps step={step} />
      {step === 1 && (
        <StepName
          onDone={(s) => {
            setShop(s)
            setStep(2)
          }}
        />
      )}
      {step === 2 && shop && <StepPhotos shop={shop} onDone={() => setStep(3)} />}
      {step === 3 && shop && (
        <StepDone
          shop={shop}
          onFinish={() => void queryClient.invalidateQueries({ queryKey: ['shops'] })}
        />
      )}
    </div>
  )
}

function Steps({ step }: { step: number }) {
  return (
    <div className="ob__steps">
      {[1, 2, 3].map((n) => (
        <i key={n} className={n === step ? 'now' : n < step ? 'done' : ''} />
      ))}
      <span>Шаг {step} из 3</span>
    </div>
  )
}

function StepName({ onDone }: { onDone: (shop: Shop) => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Пока адрес не трогали руками, ведём его за названием: продавцу
  // не нужно думать про slug, но подправить его можно.
  const effectiveSlug = touched ? slug : slugify(name)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      onDone(await api.createShop(effectiveSlug, name.trim()))
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          slug_taken: 'Этот адрес уже занят — попробуйте другой',
          invalid_slug: 'Адрес: 3–63 символа, латиница, цифры и дефисы',
          invalid_name: 'Укажите название (до 200 символов)',
        }
        setError(messages[err.code] ?? err.message)
      } else {
        setError('Сеть недоступна, попробуйте ещё раз')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <h1>Как будет называться ваша витрина?</h1>
      <p className="ob__lead">
        Из названия сложится ссылка, которую вы будете отправлять покупателям.
      </p>

      <label className="field">
        <span>Название</span>
        <input className="inp" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>Адрес витрины</span>
        <input
          className="inp"
          required
          value={effectiveSlug}
          onChange={(e) => {
            setTouched(true)
            setSlug(e.target.value)
          }}
          placeholder="seoul-wear"
        />
        <p className="hint">
          {location.origin}/{effectiveSlug || 'адрес'} — позже поменять будет сложно,
          ссылка уже разойдётся по покупателям.
        </p>
      </label>

      {error && <p className="hint text-danger">{error}</p>}
      <button type="submit" className="btn btn--primary w-full" disabled={busy || !name.trim()}>
        Дальше
      </button>
    </form>
  )
}

function StepPhotos({ shop, onDone }: { shop: Shop; onDone: () => void }) {
  const [uppy, setUppy] = useState<Uppy | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let created: Uppy | null = null
    // Альбом заводим сразу: фото не существует вне альбома, а спрашивать
    // про структуру каталога на втором экране — потерять человека.
    void api
      .createAlbum(shop.id, 'Первые товары')
      .then((album) => {
        if (cancelled) return
        created = new Uppy({
          locale: ru_RU,
          restrictions: { allowedFileTypes: ['image/*', '.heic', '.heif'], maxFileSize: 50 * 1024 * 1024 },
        }).use(AwsS3, {
          shouldUseMultipart: false,
          async getUploadParameters(file) {
            const { photo_id, url } = await api.presign(shop.id, album.id, file.size ?? 0)
            created?.setFileMeta(file.id, { photoId: photo_id })
            return { method: 'PUT', url, headers: {} }
          },
        })
        created.on('complete', (result) => {
          const ids = (result.successful ?? [])
            .map((f) => (f.meta as { photoId?: string }).photoId)
            .filter((id): id is string => Boolean(id))
          if (ids.length > 0) void api.confirm(shop.id, ids).then(onDone)
        })
        setUppy(created)
      })
      .catch(() => !cancelled && setError('Не удалось создать альбом'))
    return () => {
      cancelled = true
      created?.destroy()
    }
  }, [shop.id, onDone])

  return (
    <div>
      <h1>Загрузите первые товары</h1>
      <p className="ob__lead">
        Выберите фотографии одной пачкой — например, все ракурсы одной модели.
        Названия и цены добавим потом.
      </p>
      {error && <p className="hint text-danger">{error}</p>}
      {uppy ? (
        <Dashboard uppy={uppy} height={280} proudlyDisplayPoweredByUppy={false} note="JPEG, PNG, WebP или HEIC, до 50 МБ" />
      ) : (
        <p className="text-ink-2">Готовим загрузку…</p>
      )}
      {/* Пропуск обязателен: продавец мог зайти с компьютера, где фото нет. */}
      <button type="button" className="ob__skip" onClick={onDone}>
        Пропустить и загрузить позже
      </button>
    </div>
  )
}

function StepDone({ shop, onFinish }: { shop: Shop; onFinish: () => void }) {
  const [copied, setCopied] = useState(false)
  const url = `${location.origin}/${shop.slug}`

  return (
    <div>
      <div className="ob__done" aria-hidden="true">✓</div>
      <h1>Витрина готова</h1>
      <p className="ob__lead">
        Отправьте ссылку первому покупателю — и посмотрите, как она развернётся в переписке.
      </p>

      <div className="ob__link">
        <p>{url}</p>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => {
            void navigator.clipboard.writeText(url)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Скопировано' : 'Скопировать ссылку'}
        </button>
      </div>

      <button className="btn btn--ghost w-full" onClick={onFinish}>
        Перейти в кабинет
      </button>
      <p className="hint mt-3 text-center">
        Дальше можно добавить категории, описания и настроить оформление.
      </p>
    </div>
  )
}
