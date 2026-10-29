import { SITE_URL } from '@/lib/api'

// Адрес, по которому нет витрины (макет 15 · «Витрина не найдена»): только
// верхняя панель площадки, без шапки продавца. «Создать свою витрину» —
// регистрация, «На главную вуад» — лендинг.
export default function NotFound() {
  return (
    <main className="page sf404">
      <div className="shopbar">
        <a href="/" className="shopbar__brand">
          вуад
        </a>
        <a href="/app/register" className="shopbar__cta">
          Создать <span>свою </span>витрину →
        </a>
      </div>
      <div className="sf404__body">
        <p className="sf404__code" aria-hidden="true">
          404
        </p>
        <h1>Витрина не найдена</h1>
        <p>Проверьте адрес — возможно, в нём опечатка. Или продавец удалил витрину.</p>
        <div className="sf404__actions">
          <a className="btn btn--primary" href="/app/register">
            Создать свою витрину
          </a>
          <a className="btn btn--ghost" href="/">
            На главную вуад
          </a>
        </div>
      </div>
      <p className="sf404__domain">{new URL(SITE_URL).host}</p>
    </main>
  )
}
