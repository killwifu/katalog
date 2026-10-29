'use client'

import { CircleCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

// Уведомление «Ссылка скопирована» (макет 15): сверху по центру, 3 секунды.
// light — светлое, под верхней панелью просмотра фото.
export function useToast(): [JSX.Element | null, (text: string) => void] {
  const [text, setText] = useState('')
  const [seq, setSeq] = useState(0)
  useEffect(() => {
    if (!text) return
    const t = setTimeout(() => setText(''), 3000)
    return () => clearTimeout(t)
  }, [text, seq])
  const node = text ? (
    <div className="sftoast" role="status">
      <CircleCheck size={18} strokeWidth={1.8} aria-hidden="true" />
      {text}
    </div>
  ) : null
  return [
    node,
    (t: string) => {
      setText(t)
      setSeq((n) => n + 1)
    },
  ]
}

// Копирование в буфер: Clipboard API, а без него (старый браузер, не https) —
// выделение во временном поле.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.append(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  }
}
