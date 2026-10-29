'use client'

import { CircleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { AlbumPage } from '@/lib/api'
import { messageText } from '@/lib/links'
import { AlbumGrid } from './AlbumGrid'
import { AlbumHead, type AlbumHeadProps } from './AlbumHead'
import { ContactMenu } from './ContactMenu'
import { LockIcon } from './LockIcon'
import { PhotoGrid } from './PhotoGrid'

// Альбом под паролем (макет 15). Серверный рендер его содержимого не видит
// вовсе — страница кешируется для всех, и закрытое в кеш попасть не должно.
// Покупатель вводит пароль, получает пропуск и дальше запрашивает фото
// прямо из браузера. Пропуск в localStorage: «браузер запоминает доступ
// к этому альбому» (на сервере пропуск живёт 12 часов).
//
// parentId — у подальбома без своего пароля замок родителя, и пропуск,
// полученный на странице родителя, открывает и его.
type Props = { slug: string; albumId: string; albumSlug: string; parentId?: string | null; head: AlbumHeadProps }

const tokenKey = (albumId: string) => `album-pass:${albumId}`

function readToken(id: string): string | null {
  try {
    return localStorage.getItem(tokenKey(id))
  } catch {
    // Хранилище недоступно (приватный режим) — просто спросим пароль.
    return null
  }
}

async function loadAlbum(slug: string, albumId: string, token: string): Promise<AlbumPage | null> {
  const res = await fetch(`/api/v1/public/shops/${encodeURIComponent(slug)}/albums/${encodeURIComponent(albumId)}`, {
    headers: { 'X-Album-Token': token },
    cache: 'no-store',
  })
  if (!res.ok) return null
  const data = (await res.json()) as AlbumPage
  // Пропуск истёк или пароль сменили — альбом снова закрыт.
  return data.album.locked ? null : data
}

export function LockedAlbum({ slug, albumId, albumSlug, parentId, head }: Props) {
  const [data, setData] = useState<AlbumPage | null>(null)
  const [token, setToken] = useState('')
  // checking — пока проверяем сохранённый пропуск: форму не показываем,
  // чтобы она не мигала у того, кто пароль уже вводил.
  const [state, setState] = useState<'checking' | 'form' | 'busy'>('checking')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  // Блокировка после 5 неверных попыток: до какого момента (мс).
  const [lockedUntil, setLockedUntil] = useState(0)

  useEffect(() => {
    let alive = true
    const saved = [albumId, parentId].map((id) => (id ? readToken(id) : null)).filter((t): t is string => !!t)
    if (saved.length === 0) {
      setState('form')
      return
    }
    void (async () => {
      for (const t of saved) {
        const album = await loadAlbum(slug, albumId, t)
        if (!alive) return
        if (album) {
          setToken(t)
          setData(album)
          break
        }
      }
      setState('form')
    })()
    return () => {
      alive = false
    }
  }, [slug, albumId, parentId])

  useEffect(() => {
    if (!lockedUntil) return
    const t = setTimeout(() => setLockedUntil(0), Math.max(0, lockedUntil - Date.now()))
    return () => clearTimeout(t)
  }, [lockedUntil])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) {
      setError('Введите пароль')
      return
    }
    setState('busy')
    setError('')
    try {
      const res = await fetch(
        `/api/v1/public/shops/${encodeURIComponent(slug)}/albums/${encodeURIComponent(albumId)}/unlock`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) },
      )
      if (res.status === 403) {
        setError('Неверный пароль. Проверьте раскладку и регистр или уточните у продавца.')
      } else if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number }
        setLockedUntil(Date.now() + (body.retry_after || 60) * 1000)
      } else if (!res.ok) {
        setError('Не удалось проверить пароль. Попробуйте ещё раз')
      } else {
        const pass = (await res.json()) as { token: string }
        const album = await loadAlbum(slug, albumId, pass.token)
        if (album) {
          try {
            localStorage.setItem(tokenKey(albumId), pass.token)
          } catch {
            // Без хранилища пропуск проживёт до перезагрузки страницы.
          }
          setToken(pass.token)
          setData(album)
        } else {
          setError('Не удалось открыть альбом. Попробуйте ещё раз')
        }
      }
    } catch {
      setError('Нет связи. Проверьте интернет и попробуйте ещё раз')
    }
    setState('form')
  }

  if (data) {
    return (
      <>
        <AlbumHead {...head} description={data.album.description} updatedAt={data.album.updated_at} />
        {data.children.length > 0 && (
          <section className="section">
            <h2 className="section__head">Внутри</h2>
            <AlbumGrid shopSlug={slug} albums={data.children} />
          </section>
        )}
        <PhotoGrid
          photos={data.photos}
          total={data.total}
          perPage={data.per_page}
          shop={head.shop}
          albumTitle={head.title}
          source={{ shopSlug: slug, albumSlug, albumId, token }}
        />
      </>
    )
  }

  if (state === 'checking') return <p className="empty">Открываем альбом…</p>

  const blocked = lockedUntil > 0
  const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000))
  return (
    <form className="lockgate" onSubmit={(e) => void submit(e)}>
      <span className="lockgate__ico" aria-hidden="true">
        <LockIcon />
      </span>
      <h2>Альбом защищён паролем</h2>
      <p>
        «{head.title}» · {head.photoCount} фото. Пароль выдаёт продавец — если его у вас нет, спросите.
      </p>
      {blocked && (
        <p className="lockgate__alert" role="alert">
          <CircleAlert size={18} strokeWidth={1.8} aria-hidden="true" />
          Слишком много попыток. Попробуйте снова через {minutes} {minutesWord(minutes)} или спросите пароль у
          продавца.
        </p>
      )}
      <label className="lockgate__field">
        <span>Пароль</span>
        <input
          type="password"
          value={password}
          placeholder="Введите пароль"
          // Телефон: клавиатура открывается сразу на поле (макет 15).
          autoFocus
          disabled={blocked}
          onChange={(e) => {
            setPassword(e.target.value)
            setError('')
          }}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'lockgate-error' : undefined}
        />
      </label>
      {error && (
        <p className="lockgate__err" id="lockgate-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn--primary btn--block" disabled={state === 'busy' || blocked}>
        {state === 'busy' ? 'Проверяем…' : 'Открыть альбом'}
      </button>
      <ContactMenu
        shop={head.shop}
        text={messageText(head.shop.msg_template, head.url)}
        variant="link"
        label="Спросить пароль у продавца"
        className="lockgate__ask"
      />
    </form>
  )
}

function minutesWord(n: number): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 'минуту'
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'минуты'
  return 'минут'
}
