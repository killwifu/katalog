// Сколько загрузок сейчас в пути — по всему кабинету (файлы и ещё не
// отправленные подтверждения). Загрузка живёт вне
// страницы: продавец уходит из альбома, а пачка продолжает ехать. Но
// защита от закрытия вкладки снималась вместе со страницей, и закрытие
// обрывало загрузку молча, а на других страницах не было видно, что она
// вообще идёт.
let inFlight = 0
const listeners = new Set<() => void>()

export function bump(delta: number): void {
  inFlight += delta
  listeners.forEach((f) => f())
}

export function subscribeUploads(f: () => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

export function uploadsInFlight(): number {
  return inFlight
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (inFlight === 0) return
    e.preventDefault()
    // Значение игнорируется современными браузерами, но требуется,
    // чтобы диалог вообще показался.
    e.returnValue = ''
  })
}

// Загрузчик онбординга (Dashboard) грузит мимо uploadToAlbum — считаем его
// файлы по событиям Uppy. Возвращает отписку: остаток списывается.
type UppyLike = {
  on(event: 'upload', cb: (uploadID: string, files: { id: string }[]) => void): unknown
  on(event: 'upload-success' | 'upload-error', cb: (file: { id: string } | undefined) => void): unknown
  on(event: 'cancel-all', cb: () => void): unknown
}

export function trackUppy(uppy: UppyLike): () => void {
  const pending = new Set<string>()
  const drop = (id: string) => {
    if (pending.delete(id)) bump(-1)
  }
  const clear = () => {
    bump(-pending.size)
    pending.clear()
  }
  uppy.on('upload', (_id, files) => {
    for (const f of files) {
      if (!pending.has(f.id)) {
        pending.add(f.id)
        bump(1)
      }
    }
  })
  uppy.on('upload-success', (f) => f && drop(f.id))
  uppy.on('upload-error', (f) => f && drop(f.id))
  uppy.on('cancel-all', clear)
  return clear
}
