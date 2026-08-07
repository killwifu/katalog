'use client'

import { useState } from 'react'
import styles from './remove-bg.module.css'

// Инструмент «убрать фон». Вёрстка готова, обработки ещё нет:
// эндпоинта под это в API нет (см. план страниц). Поэтому выбранный файл
// никуда не уходит, а кнопка скачивания выключена — вместо молчаливой
// поломки показываем, что именно недоступно.

const BACKGROUNDS = ['Прозрачный', 'Белый', 'Свой цвет']
const FORMATS = ['PNG', 'JPG', 'WEBP']

export function RemoveBgTool() {
  const [position, setPosition] = useState(50)
  const [background, setBackground] = useState(BACKGROUNDS[0])
  const [format, setFormat] = useState(FORMATS[0])
  const [picked, setPicked] = useState<string | null>(null)

  return (
    <section className="wrap">
      <div className={styles.tool}>
        <div>
        <div className={styles.drop}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round">
            <path d="M15 8h.01" />
            <path d="M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7.5" />
            <path d="m3 16 5-5c.93-.9 2.07-.9 3 0l4 4" />
            <path d="M16 19h6M19 16v6" />
          </svg>
          <h3>Перетащите фотографию сюда</h3>
          <p>JPG, PNG или HEIC до 12 МБ</p>
          <div className={styles.dropBtns}>
            <label className="btn btn--primary">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Снять фото
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => setPicked(e.target.files?.[0]?.name ?? null)}
              />
            </label>
            <label className="btn btn--ghost">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7L11 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
              </svg>
              Выбрать файл
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => setPicked(e.target.files?.[0]?.name ?? null)}
              />
            </label>
          </div>
          {picked && (
            <p className={styles.status} role="status">
              Выбрано: {picked}. Обработка пока не подключена — файл никуда не отправлен.
            </p>
          )}
        </div>

        <p className={`muted ${styles.hint}`}>Как это выглядит — потяните ползунок</p>

        {/* Иллюстрация результата. Ползунок открывает слой «после» слева направо:
            тянешь к «после» — результата становится больше. Обратный порядок
            (как в исходном макете) противоречил бы подписям у ползунка. */}
        <div className={styles.cmp}>
          <svg viewBox="0 0 400 300" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <pattern id="rug" width="26" height="26" patternUnits="userSpaceOnUse">
                <rect width="26" height="26" fill="#B4B2A9" />
                <circle cx="13" cy="13" r="5" fill="#8B897F" />
              </pattern>
              <pattern id="chk" width="24" height="24" patternUnits="userSpaceOnUse">
                <rect width="24" height="24" fill="#F4F3F0" />
                <rect width="12" height="12" fill="#DFDDD6" />
                <rect x="12" y="12" width="12" height="12" fill="#DFDDD6" />
              </pattern>
            </defs>
            <rect width="400" height="300" fill="url(#rug)" />
            <path d="M150 70 L200 92 L250 70 L286 104 L262 130 L256 240 L144 240 L138 130 L114 104 Z" fill="#C9502A" />
            <path d="M200 92 L200 240" stroke="#8E3417" strokeWidth="3" />
          </svg>
          <div className={styles.after} style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
            <svg viewBox="0 0 400 300" preserveAspectRatio="none" aria-hidden="true">
              <rect width="400" height="300" fill="url(#chk)" />
              <path d="M150 70 L200 92 L250 70 L286 104 L262 130 L256 240 L144 240 L138 130 L114 104 Z" fill="#C9502A" />
              <path d="M200 92 L200 240" stroke="#8E3417" strokeWidth="3" />
            </svg>
          </div>
          <div className={styles.handle} style={{ left: `${position}%` }} />
        </div>

        <div className={styles.cmpRow}>
          <span>до</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={position}
            onChange={(e) => setPosition(Number(e.target.value))}
            aria-label="Сравнение до и после"
          />
          <span>после</span>
        </div>
      </div>

      <aside>
        <div className="card">
          <p className={styles.optsLabel}>Фон</p>
          <div className={styles.optsRow}>
            {BACKGROUNDS.map((item) => (
              <button
                key={item}
                type="button"
                className={`${styles.opt} ${item === background ? styles.optOn : ''}`}
                aria-pressed={item === background}
                onClick={() => setBackground(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <p className={styles.optsLabel}>Формат</p>
          <div className={styles.optsRow}>
            {FORMATS.map((item) => (
              <button
                key={item}
                type="button"
                className={`${styles.opt} ${item === format ? styles.optOn : ''}`}
                aria-pressed={item === format}
                onClick={() => setFormat(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <button type="button" className="btn btn--primary btn--block" disabled>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 3v12" />
              <path d="m7 11 5 5 5-5" />
              <path d="M4 20h16" />
            </svg>
            Скачать
          </button>
        </div>

        <div className={styles.limit}>
          <b>3 обработки в день бесплатно</b>
          <p>
            Создайте витрину — и обрабатывайте фотографии пачками прямо в альбомах, без
            ежедневного лимита.
          </p>
          <a className="btn btn--light btn--sm" href="/app/register">
            Создать бесплатно
          </a>
        </div>
        </aside>
      </div>
    </section>
  )
}
