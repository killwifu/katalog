// Уведомление, которое переживает переход между страницами: альбом удалили
// на его странице, а «перемещён в Удаленное · Отменить» надо показать уже
// в списке альбомов.
export type Flash = { text: string; undoAlbumId?: string }

let pending: Flash | null = null

export function setFlash(flash: Flash): void {
  pending = flash
}

export function takeFlash(): Flash | null {
  const flash = pending
  pending = null
  return flash
}
