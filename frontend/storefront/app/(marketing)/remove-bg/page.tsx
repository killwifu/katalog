import type { Metadata } from 'next'
import { RemoveBgTool } from './RemoveBgTool'
import styles from './remove-bg.module.css'

export const metadata: Metadata = {
  title: 'Убрать фон с фотографии — Katalog',
  description:
    'Уберите фон с фотографии товара бесплатно и без регистрации. Результат за несколько секунд.',
}

const FACTS = [
  'Обработка за 3–5 секунд',
  'Удаляем фото с серверов через час',
  'JPG, PNG, HEIC до 12 МБ',
]

export default function RemoveBgPage() {
  return (
    <main>
      <section className={styles.top}>
        <div className="wrap">
          <h1>Убрать фон с фотографии</h1>
          {/* Обработки ещё нет, файл никуда не уходит — обещать что-либо
              про наши серверы и сроки хранения нельзя, пока туда ничего
              не попадает. Про неготовность говорим сразу, а не после того,
              как посетитель выберет файл. */}
          <p>Бесплатно и без регистрации.</p>
          <p className="muted">
            Инструмент ещё готовится: можно посмотреть, как это будет выглядеть,
            но обработка пока не подключена.
          </p>
        </div>
      </section>

      <RemoveBgTool />

      <div className="wrap">
        <div className={styles.facts}>
          {FACTS.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      </div>
    </main>
  )
}
