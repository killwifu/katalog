'use client'

import { Share2 } from 'lucide-react'
import { copyText, useToast } from './Toast'

// «Поделиться» альбомом (макет 15): на телефоне — системное меню
// «Поделиться», если оно есть; иначе ссылка копируется с уведомлением.
export function ShareButton({ title }: { title: string }) {
  const [toast, show] = useToast()
  const share = async () => {
    const url = location.origin + location.pathname
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title, url })
        return
      } catch (e) {
        // Покупатель закрыл меню — копировать за него не нужно.
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    show((await copyText(url)) ? 'Ссылка на альбом скопирована' : 'Не удалось скопировать ссылку')
  }
  return (
    <>
      <button type="button" className="btn btn--ghost sfshare" onClick={() => void share()} aria-label="Поделиться">
        <Share2 size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>Поделиться</span>
      </button>
      {toast}
    </>
  )
}
