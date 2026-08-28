import { Link } from '@tanstack/react-router'

// Экран сбоя маршрута. Без него любая ошибка рендера — обрыв сети,
// чанк, не доехавший после деплоя, неожиданный ответ API — оставляет
// продавца перед пустой белой страницей без единой подсказки.
export function ErrorPage({ error }: { error?: Error }) {
  return (
    <div className="emptybox">
      <div className="emptybox__ico" aria-hidden="true">⚠️</div>
      <h3>Страница не открылась</h3>
      <p>
        Что-то пошло не так. Обновите страницу — обычно этого достаточно.
        Если ошибка повторяется, напишите в поддержку.
      </p>
      {error?.message && <p className="text-xs text-ink-2">{error.message}</p>}
      <div className="mt-4 flex justify-center gap-2">
        <button onClick={() => location.reload()} className="btn btn--primary">
          Обновить
        </button>
        <Link to="/" className="btn">
          На главную
        </Link>
      </div>
    </div>
  )
}

export function NotFoundPage() {
  return (
    <div className="emptybox">
      <div className="emptybox__ico" aria-hidden="true">🧭</div>
      <h3>Такой страницы нет</h3>
      <p>Проверьте адрес — возможно, ссылка устарела.</p>
      <div className="mt-4 flex justify-center">
        <Link to="/" className="btn btn--primary">
          На главную
        </Link>
      </div>
    </div>
  )
}
