import type { Metadata } from 'next'
import { UpdatesFeed } from './UpdatesFeed'
import styles from './updates.module.css'

export const metadata: Metadata = {
  title: 'Обновления — Katalog',
  description: 'Что мы добавили и починили в сервисе. Обновляем почти каждую неделю.',
}

export default function UpdatesPage() {
  return (
    <main>
      <section className={styles.top}>
        <div className="wrap">
          <h1>Обновления</h1>
          <p>Что мы добавили и починили. Обновляем сервис почти каждую неделю.</p>
        </div>
      </section>
      <UpdatesFeed />
    </main>
  )
}
