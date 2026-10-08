import { Check, Copy, Download, Info, Link as LinkIcon, Lock, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/copyText'
import { Icon } from '../lib/icons'
import { Portal } from '../lib/Portal'

// «Поделиться» по макетам 09 (витрина, с QR-кодом) и 13 (альбом).
// Ссылка всегда видна в поле: если буфер обмена недоступен, её можно
// выделить и скопировать руками — раньше кнопка в таком случае молчала.
export function ShareDialog({
  title,
  lead,
  label,
  url,
  note,
  noteIcon,
  qr,
  onClose,
}: {
  title: string
  lead: string
  label: string
  url: string
  // Пояснение под ссылкой: кому она откроется. noteIcon — значок перед
  // ним (макет 13: замок у альбома с паролем, «i» — без пароля).
  note?: string
  noteIcon?: 'lock' | 'info'
  // Имя файла для QR-кода; без него код не показывается.
  qr?: string
  onClose: () => void
}) {
  const field = useRef<HTMLInputElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState<'no' | 'yes' | 'fail'>('no')

  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  // Генератор кода нужен только в этом окне — грузим его по требованию,
  // а не в основном бандле кабинета.
  useEffect(() => {
    if (!qr) return
    let alive = true
    void import('qrcode-generator').then(({ default: qrcode }) => {
      const el = canvas.current
      if (!alive || !el) return
      const code = qrcode(0, 'M')
      code.addData(url)
      code.make()
      const count = code.getModuleCount()
      // Поля в четыре модуля — требование стандарта, без них часть
      // сканеров код не читает.
      const quiet = 4
      const scale = Math.max(4, Math.floor(1024 / (count + quiet * 2)))
      el.width = el.height = (count + quiet * 2) * scale
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, el.width, el.height)
      ctx.fillStyle = '#000'
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (code.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale)
        }
      }
    })
    return () => {
      alive = false
    }
  }, [qr, url])

  const copy = async () => {
    try {
      if (!(await copyText(url))) throw new Error('clipboard')
      setCopied('yes')
      // Макет: кнопка на 2 секунды становится зелёной «Ссылка скопирована»,
      // окно не закрывается.
      setTimeout(() => setCopied((c) => (c === 'yes' ? 'no' : c)), 2000)
    } catch {
      // Буфер отказывает в небезопасном контексте и без разрешения —
      // выделяем ссылку, чтобы осталось скопировать её руками.
      field.current?.select()
      setCopied('fail')
    }
  }

  const download = () => {
    canvas.current?.toBlob((blob) => {
      if (!blob) return
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${qr}.png`
      link.click()
      URL.revokeObjectURL(link.href)
    }, 'image/png')
  }

  return (
    <Portal><div className="modal__back" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal share-dialog ${qr ? 'modal--share' : 'modal--form modal--sharealb'}`}>
        <div className="modal__head">
          <div>
            <h2>{title}</h2>
            <p>{lead}</p>
          </div>
          <span className="spacer" />
          <button className="modal__x" onClick={onClose} aria-label="Закрыть">
            <Icon as={X} size={20} />
          </button>
        </div>
        <div className="share">
          <div className="share__main">
            <label className="field">
              <span>{label}</span>
              <span className="share__inp">
                <Icon as={LinkIcon} />
                <input ref={field} value={url} readOnly onFocus={(e) => e.target.select()} />
              </span>
            </label>
            <button
              className={`btn btn--block ${copied === 'yes' ? 'btn--copied' : 'btn--primary'}`}
              onClick={() => void copy()}
            >
              <Icon as={copied === 'yes' ? Check : qr ? Copy : LinkIcon} size={qr ? 16 : 18} />
              {copied === 'yes' ? 'Ссылка скопирована' : qr ? 'Копировать' : 'Копировать ссылку'}
            </button>
            {copied === 'fail' ? (
              <p className="hint text-danger" role="status">
                Не удалось скопировать автоматически — ссылка выделена, скопируйте её вручную
              </p>
            ) : (
              note && (
                <p className="share__note" role="status">
                  {noteIcon && <Icon as={noteIcon === 'lock' ? Lock : Info} size={14} />}
                  {note}
                </p>
              )
            )}
          </div>
          {qr && (
            <div className="share__qr">
              <span className="share__code">
                <canvas ref={canvas} aria-label="QR-код со ссылкой на витрину" role="img" />
              </span>
              <p>
                <b>Поделитесь с покупателями</b>
                Отсканируйте, чтобы открыть витрину
              </p>
              <button className="btn btn--ghost btn--pill" onClick={download}>
                <Icon as={Download} />
                Скачать QR-код
              </button>
            </div>
          )}
        </div>
      </div>
    </div></Portal>
  )
}
