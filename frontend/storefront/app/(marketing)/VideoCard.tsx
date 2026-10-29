'use client'

import { useState, type ReactNode } from 'react'
import s from './home.module.css'

// Ролик «Как это работает» (макеты 01, 03): обложка с синей кнопкой, по
// нажатию — плеер в той же карточке, со звуком, без автозапуска страницы.
// Панель управления (пауза, перемотка, время, звук, полный экран) и пауза
// по клику — штатные у <video controls>. После окончания — снова обложка.
// Адрес ролика — LANDING_VIDEO_URL; без него кнопки воспроизведения нет.
export function VideoCard({ src, cover }: { src: string; cover: ReactNode }) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className={s.videoBox}>
      {playing ? (
        <video className={s.video} src={src} controls autoPlay playsInline onEnded={() => setPlaying(false)} />
      ) : (
        <>
          {cover}
          {src && (
            <button type="button" className={s.play} aria-label="Смотреть видео" onClick={() => setPlaying(true)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
              </svg>
            </button>
          )}
        </>
      )}
    </div>
  )
}
