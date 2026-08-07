'use client'

import { useState } from 'react'
import { ENTRIES, FILTERS, KIND_LABELS, KIND_TAG_CLASS, type UpdateKind } from './entries'
import styles from './updates.module.css'

// Фильтр по типу записи. Список короткий, поэтому фильтруем на клиенте:
// без перезагрузки и без параметров в адресе, которые ломали бы якоря записей.
export function UpdatesFeed() {
  const [filter, setFilter] = useState<UpdateKind | 'all'>('all')
  const shown = filter === 'all' ? ENTRIES : ENTRIES.filter((e) => e.kind === filter)

  return (
    <>
      <div className="wrap">
        <div className={styles.filters}>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`chip ${f.value === filter ? 'is-on' : ''}`}
              aria-pressed={f.value === filter}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`wrap ${styles.feed}`}>
        {shown.map((entry) => (
          <article key={entry.id} id={entry.id} className={styles.entry}>
            <div className={styles.meta}>
              <span className={KIND_TAG_CLASS[entry.kind]}>{KIND_LABELS[entry.kind]}</span>
              <span className={styles.date}>{entry.date}</span>
            </div>
            <div className={styles.body}>
              <h3>{entry.title}</h3>
              <p>{entry.text}</p>
              {entry.shot && <div className={styles.shot} aria-hidden="true" />}
            </div>
          </article>
        ))}
        {shown.length === 0 && <p className="empty">Записей этого типа пока нет.</p>}
      </div>
    </>
  )
}
