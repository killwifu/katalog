'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { AlbumPage, ShopPublic } from '@/lib/api'
import { AlbumGrid } from './AlbumGrid'
import { LockIcon } from './LockIcon'
import { PhotoGrid } from './PhotoGrid'

// Альбом под паролем. Серверный рендер его содержимого не видит вовсе —
// страница кешируется для всех, и закрытое в кеш попасть не должно.
// Покупатель вводит пароль, получает пропуск и дальше запрашивает фото
// прямо из браузера. Пропуск живёт в sessionStorage: вкладку закрыли —
// пароль спросят снова, а на общем телефоне он не останется навсегда.

// parentId — у подальбома без своего пароля замок родителя, и пропуск,
// полученный на странице родителя, открывает и его: второй раз пароль
// не спрашиваем.
type Props = { slug: string; albumId: string; parentId?: string | null; title: string; shop: ShopPublic }

const tokenKey = (albumId: string) => `album-pass:${albumId}`

async function loadAlbum(slug: string, albumId: string, token: string, page: number): Promise<AlbumPage | null> {
  const res = await fetch(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/albums/${encodeURIComponent(albumId)}${page > 1 ? `?page=${page}` : ''}`,
    { headers: { 'X-Album-Token': token }, cache: 'no-store' },
  )
  if (!res.ok) return null
  const data = (await res.json()) as AlbumPage
  // Пропуск истёк или пароль сменили — альбом снова закрыт.
  return data.album.locked ? null : data
}

export function LockedAlbum({ slug, albumId, parentId, title, shop }: Props) {
  const [data, setData] = useState<AlbumPage | null>(null)
  const [token, setToken] = useState('')
  // checking — пока проверяем пропуск, сохранённый в этой вкладке: форму
  // не показываем, чтобы она не мигала у того, кто пароль уже вводил.
  const [state, setState] = useState<'checking' | 'form' | 'busy'>('checking')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const saved: string[] = []
    try {
      for (const id of [albumId, parentId]) {
        const t = id ? sessionStorage.getItem(tokenKey(id)) : null
        if (t) saved.push(t)
      }
    } catch {
      // Хранилище недоступно (приватный режим) — просто спросим пароль.
    }
    if (saved.length === 0) {
      setState('form')
      return
    }
    const page = Math.max(1, Number.parseInt(new URLSearchParams(location.search).get('page') ?? '1', 10) || 1)
    void (async () => {
      for (const t of saved) {
        const album = await loadAlbum(slug, albumId, t, page)
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
        setError('Неверный пароль')
      } else if (res.status === 429) {
        setError('Слишком много попыток — подождите минуту и попробуйте снова')
      } else if (!res.ok) {
        setError('Не удалось проверить пароль. Попробуйте ещё раз')
      } else {
        const pass = (await res.json()) as { token: string }
        const album = await loadAlbum(slug, albumId, pass.token, 1)
        if (album) {
          try {
            sessionStorage.setItem(tokenKey(albumId), pass.token)
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

  const goTo = async (page: number) => {
    const album = await loadAlbum(slug, albumId, token, page)
    if (!album) {
      // Пропуск перестал действовать посреди просмотра.
      setData(null)
      setError('Пароль нужно ввести заново')
      return
    }
    setData(album)
    scrollTo({ top: 0 })
  }

  if (data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.per_page))
    return (
      <>
        {data.album.description && <p className="albumdesc">{data.album.description}</p>}
        {data.children.length > 0 && (
          <section className="section">
            <h2 className="section__head">Внутри</h2>
            <AlbumGrid shopSlug={slug} albums={data.children} />
          </section>
        )}
        <PhotoGrid photos={data.photos} shop={shop} />
        {totalPages > 1 && (
          <nav className="pagination" aria-label="Страницы альбома">
            {data.page > 1 && (
              <button type="button" onClick={() => void goTo(data.page - 1)}>
                <ChevronLeft size={16} strokeWidth={1.6} aria-hidden="true" />
                Назад
              </button>
            )}
            <span>
              {data.page} / {totalPages}
            </span>
            {data.page < totalPages && (
              <button type="button" onClick={() => void goTo(data.page + 1)}>
                Вперёд
                <ChevronRight size={16} strokeWidth={1.6} aria-hidden="true" />
              </button>
            )}
          </nav>
        )}
      </>
    )
  }

  if (state === 'checking') return <p className="empty">Открываем альбом…</p>

  return (
    <form className="lockgate" onSubmit={(e) => void submit(e)}>
      <span className="lockgate__ico" aria-hidden="true">
        <LockIcon />
      </span>
      <h2>Альбом закрыт паролем</h2>
      {/* Без «выше»: на телефоне кнопки связи закреплены внизу экрана. */}
      <p>Пароль от альбома «{title}» можно узнать у продавца — напишите ему по кнопкам связи на этой странице.</p>
      <label className="lockgate__field">
        <span>Пароль</span>
        <input
          type="password"
          value={password}
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
      <button type="submit" className="btn btn--primary btn--block" disabled={state === 'busy'}>
        {state === 'busy' ? 'Проверяем…' : 'Открыть альбом'}
      </button>
    </form>
  )
}
