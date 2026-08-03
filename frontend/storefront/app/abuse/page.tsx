import type { Metadata } from 'next'
import { ComplaintForm } from '../../components/ComplaintForm'

export const metadata: Metadata = { title: 'Жалоба на контент — Katalog' }

export default function AbusePage() {
  return (
    <main className="page legal">
      <h1>Жалоба на контент</h1>
      <p>
        Если размещённый на витрине контент нарушает ваши права, заполните
        форму — модераторы рассмотрят обращение. Порядок описан в{' '}
        <a href="/content-policy">политике контента</a>.
      </p>
      <ComplaintForm />
    </main>
  )
}
