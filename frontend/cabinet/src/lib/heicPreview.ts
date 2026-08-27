// Превью HEIC до отправки.
//
// Айфоны снимают в HEIC по умолчанию. Сервер его декодирует (libvips умеет),
// и Safari показывает нативно — поэтому при загрузке с телефона всё в порядке.
// Ломается другой сценарий: продавец перекинул фотографии на компьютер
// и грузит из Chrome или Firefox, которые HEIC не декодируют. Он видит
// пустые плитки и не понимает, что именно отправляет.
//
// Конвертируем ТОЛЬКО для превью: исходник уходит в S3 как есть. HEIC
// компактнее JPEG, сервер его принимает, и переупаковка ради загрузки
// лишь раздула бы трафик с мобильного.

const HEIC_RE = /\.(heic|heif)$/i

export function isHeic(file: { name?: string; type?: string }): boolean {
  // На части систем HEIC приезжает с пустым MIME, поэтому расширение важнее.
  return HEIC_RE.test(file.name ?? '') || file.type === 'image/heic' || file.type === 'image/heif'
}

// Браузер определяем по факту, а не по User-Agent: пробуем декодировать.
// Safari справится и без конвертации, и как только HEIC научатся показывать
// остальные — они тоже перестанут её оплачивать.
async function browserCanDecode(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return false
  try {
    const bitmap = await createImageBitmap(blob)
    bitmap.close?.()
    return true
  } catch {
    return false
  }
}

// ponytail: очередь на один файл — декодер libheif работает в основном потоке,
// и параллельная конвертация пачки в 300 фото подвесит интерфейс.
// Если станет узким местом — переносить в Web Worker, а не наращивать
// параллелизм здесь.
let queue: Promise<unknown> = Promise.resolve()

export function heicPreviewURL(blob: Blob): Promise<string | null> {
  const task = queue.then(async () => {
    if (await browserCanDecode(blob)) return URL.createObjectURL(blob)
    try {
      // Декодер грузится динамически: он весит больше мегабайта, и продавцы,
      // которые HEIC не загружают, не должны за него платить.
      const { default: heic2any } = await import('heic2any')
      const out = await heic2any({ blob, toType: 'image/jpeg', quality: 0.7 })
      return URL.createObjectURL(Array.isArray(out) ? out[0] : out)
    } catch {
      // Превью — удобство, а не условие загрузки: файл уйдёт в S3 в любом
      // случае, поэтому сбой конвертации молча оставляет плитку без картинки.
      return null
    }
  })
  queue = task.catch(() => undefined)
  return task
}
