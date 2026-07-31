import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'

export function CreateShopPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.createShop(slug.trim().toLowerCase(), name.trim())
      await queryClient.invalidateQueries({ queryKey: ['shops'] })
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          slug_taken: 'Этот адрес уже занят',
          invalid_slug: 'Адрес: 3–63 символа, латиница/цифры/дефис; служебные слова запрещены',
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
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-lg bg-white p-6 shadow">
        <h1 className="mb-1 text-xl font-semibold text-gray-900">Создайте магазин</h1>
        <p className="mb-4 text-sm text-gray-500">Каталог будет доступен по адресу /{slug || 'адрес'}</p>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Название</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-sm text-gray-600">Адрес (slug)</span>
          <input
            required
            pattern="[a-z0-9-]{3,63}"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-shop"
            className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          />
        </label>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Создать
        </button>
      </form>
    </div>
  )
}
