import { Check } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type Uppy from '@uppy/core'
// Прямой путь, а не корень пакета: корень тянет DragDrop, FileInput и
// прочее с необязательными зависимостями, которых в проекте нет, — из-за
// этого `npm run dev` падал с «Could not resolve @uppy/drag-drop».
import Dashboard from '@uppy/react/lib/Dashboard'
import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type Shop } from '../api'
import { Icon } from '../lib/icons'
import { copyText } from '../lib/copyText'
import { trackUppy } from '../lib/inflight'
import { createPhotoUppy } from '../lib/uppy'
import { slugify } from './CategoriesPage'
import '@uppy/core/dist/style.min.css'
import '@uppy/dashboard/dist/style.min.css'

// Онбординг — ровно три шага (kit). Больше человек не пройдёт, а цель здесь
// не «зарегистрировать», а довести до первой отправленной ссылки: именно она
// запускает и продажи, и вирусный канал. Категории, оформление и описания
// отложены в кабинет.
const FIRST_ALBUM = 'Первые товары'

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
      // Кабинет ведёт один магазин на аккаунт. Онбординг, открытый во второй
      // вкладке, создавал ещё один — публичный, но недоступный из кабинета.
      const [existing] = await api.listShops()
      onDone(existing ?? (await api.createShop(effectiveSlug, name.trim())))
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          slug_taken: 'Этот адрес уже занят — попробуйте другой',
          invalid_slug: 'Адрес: 3–63 символа, латиница, цифры и дефисы',
          slug_reserved: 'Этот адрес занят служебными страницами сервиса — придумайте другой',
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
          {location.origin}/{effectiveSlug || 'адрес'} — менять адрес можно не чаще
          раза в полгода, и старые ссылки после смены перестают работать.
        </p>
      </label>

      {error && <p className="hint text-danger" role="alert">{error}</p>}
      <button type="submit" className="btn btn--primary w-full" disabled={busy || !name.trim()}>
        Дальше
      </button>
    </form>
  )
}

function StepPhotos({ shop, onDone }: { shop: Shop; onDone: () => void }) {
  const [uppy, setUppy] = useState<Uppy | null>(null)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [albumId, setAlbumId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let created: Uppy | null = null
    let untrack = () => {}
    // Альбом заводим сразу: фото не существует вне альбома, а спрашивать
    // про структуру каталога на втором экране — потерять человека.
    // Онбординг во второй вкладке (или после перезагрузки) заводил ещё один
    // «Первые товары» — берём уже заготовленный, пока он пустой.
    void api
      .listAlbums(shop.id)
      .then(
        (albums) =>
          albums.find((a) => a.title === FIRST_ALBUM && a.photo_count === 0) ??
          api.createAlbum(shop.id, FIRST_ALBUM),
      )
      .then((album) => {
        if (cancelled) return
        setAlbumId(album.id)
        created = createPhotoUppy({
          shopId: shop.id,
          albumId: album.id,
          // Не уводим на следующий шаг сами: продавец мог отправить первую
          // пачку и добирать вторую — экран уезжал у него из-под пальца.
          onBatchConfirmed: () => setConfirmed(true),
        })
        // Закрытие вкладки посреди первой загрузки предупреждается так же,
        // как в кабинете (lib/inflight).
        untrack = trackUppy(created)
        setUppy(created)
      })
      .catch(() => !cancelled && setError('Не удалось создать альбом'))
    return () => {
      cancelled = true
      untrack()
      created?.destroy()
    }
  }, [shop.id])

  // Пропустили, ничего не загрузив: заготовленный альбом убираем совсем —
  // иначе новый продавец видел пустой «Первые товары» вместо приветствия
  // с «Создать альбом», а на витрине — пустой каталог с одним альбомом.
  const skip = async () => {
    if (albumId && !confirmed) {
      uppy?.cancelAll()
      try {
        await api.deleteAlbum(shop.id, albumId)
        await api.purgeAlbum(shop.id, albumId)
      } catch {
        // Не вышло — альбом останется пустым черновиком, это не повод
        // держать продавца на этом шаге.
      }
    }
    onDone()
  }

  return (
    <div>
      <h1>Загрузите первые товары</h1>
      <p className="ob__lead">
        Выберите фотографии одной пачкой — например, все ракурсы одной модели.
        Названия и цены добавим потом.
      </p>
      {error && <p className="hint text-danger" role="alert">{error}</p>}
      {uppy ? (
        <Dashboard
          uppy={uppy}
          height={280}
          proudlyDisplayPoweredByUppy={false}
          note="JPEG, PNG, WebP или HEIC, до 10 МБ"
          // Своя кнопка «Готово» у Uppy очищает окно — после загрузки оно
          // выглядело пустым, будто фото пропали. Дальше ведёт «Готово, дальше».
          doneButtonHandler={null}
        />
      ) : (
        <p className="text-ink-2">Готовим загрузку…</p>
      )}
      {confirmed ? (
        <button type="button" className="btn btn--primary w-full mt-4" onClick={onDone}>
          Готово, дальше
        </button>
      ) : (
        /* Пропуск обязателен: продавец мог зайти с компьютера, где фото нет. */
        <button type="button" className="ob__skip" onClick={() => void skip()}>
          Пропустить и загрузить позже
        </button>
      )}
    </div>
  )
}

function StepDone({ shop, onFinish }: { shop: Shop; onFinish: () => void }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'fail'>('no')
  const url = `${location.origin}/${shop.slug}`

  const copy = async () => {
    try {
      if (!(await copyText(url))) throw new Error('clipboard')
      setCopied('yes')
    } catch {
      // Небезопасный контекст или отказ в разрешении: ссылку продавец
      // выделит руками, но знать об этом он должен.
      setCopied('fail')
      return
    }
    setTimeout(() => setCopied('no'), 2000)
  }

  return (
    <div>
      <div className="ob__done" aria-hidden="true">
        <Icon as={Check} size={28} />
      </div>
      <h1>Витрина готова</h1>
      <p className="ob__lead">
        Отправьте ссылку первому покупателю — и посмотрите, как она развернётся в переписке.
      </p>

      <div className="ob__link">
        <p>{url}</p>
        <button className="btn btn--primary btn--sm" onClick={() => void copy()}>
          {copied === 'yes' ? 'Скопировано' : 'Скопировать ссылку'}
        </button>
        {copied === 'fail' && (
          <p className="hint text-danger" role="alert">Не удалось скопировать — выделите ссылку вручную.</p>
        )}
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
