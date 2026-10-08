import { bump } from './inflight'
import { ALBUM_GONE, createPhotoUppy, QUOTA_REASONS } from './uppy'

// Ровно то, что принимает сервер (см. ограничения в uppy.ts и maxFileSize
// в photos_handlers.go). Проверяем ещё при выборе файла: продавец должен
// увидеть, что снимок не подходит, до того как нажмёт «Загрузить».
export const MAX_FILE_MB = 10
const ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
const ACCEPT_EXT = /\.(jpe?g|png|webp|heic|heif)$/i
export const ACCEPT_ATTR = ACCEPT_TYPES.join(',')
export const FORMATS_HINT = `JPEG, PNG, WebP, HEIC · до ${MAX_FILE_MB} МБ на одно фото`

// rejectReason — почему файл не загрузится; пусто, если подходит.
// Тип у HEIC браузеры часто не проставляют, поэтому смотрим и расширение.
export function rejectReason(file: File): string {
  if (!ACCEPT_TYPES.includes(file.type) && !ACCEPT_EXT.test(file.name)) return 'Формат не поддерживается'
  if (file.size > MAX_FILE_MB * 1024 * 1024) return `Больше ${MAX_FILE_MB} МБ`
  if (file.size === 0) return 'Пустой файл'
  return ''
}

export type RunFile = { key: string; file: File }

export type RunResult = {
  ok: string[]
  failed: { key: string; message: string }[]
  // Причина отказа по тарифу: повторять загрузку бессмысленно, пока
  // продавец не освободит место или не сменит тариф.
  quota?: string
  stopped: boolean
}

type RunOptions = {
  shopId: string
  albumId: string
  files: RunFile[]
  signal: AbortSignal
  onProgress: (key: string, percent: number) => void
  onConfirmed: () => void
}

// uploadToAlbum грузит пачку в один альбом тем же конструктором, что и
// страница альбома: presign, ограничения и подтверждение обязаны совпадать.
// Остановка через signal не теряет доехавшие файлы — их подтверждает
// обработчик cancel-all в uppy.ts.
export function uploadToAlbum({ shopId, albumId, files, signal, onProgress, onConfirmed }: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const ok: string[] = []
    const failed: { key: string; message: string }[] = []
    let quota: string | undefined
    const keyOf = new Map<string, string>()
    let left = files.length
    bump(left)
    const settle = () => {
      if (left > 0) {
        left--
        bump(-1)
      }
    }

    const uppy = createPhotoUppy({
      shopId,
      albumId,
      onBatchConfirmed: onConfirmed,
      onOutcome: (outcome) => {
        if (outcome.reason) quota = outcome.reason
      },
    })

    let settled = false
    const finish = (stopped: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      bump(-left)
      left = 0
      uppy.destroy()
      resolve({ ok, failed, quota, stopped })
    }
    const onAbort = () => finish(true)

    for (const { key, file } of files) {
      try {
        const id = uppy.addFile({ name: file.name, type: file.type, data: file })
        keyOf.set(id, key)
      } catch (e) {
        failed.push({ key, message: e instanceof Error ? e.message : 'Файл не подходит' })
        settle()
      }
    }

    uppy.on('upload-progress', (file, progress) => {
      const key = file && keyOf.get(file.id)
      if (!key || !progress.bytesTotal) return
      onProgress(key, Math.round((progress.bytesUploaded / progress.bytesTotal) * 100))
    })
    uppy.on('upload-success', (file) => {
      const key = file && keyOf.get(file.id)
      if (!key) return
      ok.push(key)
      settle()
      onProgress(key, 100)
    })
    uppy.on('upload-error', (file, error) => {
      const key = file && keyOf.get(file.id)
      if (!key) return
      const reason = Object.values(QUOTA_REASONS).find((r) => error.message.includes(r))
      if (reason) quota = reason
      failed.push({ key, message: reason ?? (error.message.includes(ALBUM_GONE) ? ALBUM_GONE : 'Ошибка сети') })
      settle()
    })

    if (signal.aborted || keyOf.size === 0) {
      finish(signal.aborted)
      return
    }
    signal.addEventListener('abort', onAbort)
    // После отмены обещание upload() может не завершиться вовсе, поэтому
    // итог отдаёт finish, а не оно само.
    uppy.upload().then(
      () => finish(false),
      () => finish(signal.aborted),
    )
  })
}

export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  // Мелкие файлы в мегабайтах давали «0,0 МБ» — выглядит как пустой файл.
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} КБ`
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace('.', ',')} МБ`
}

// plural(5, 'альбом', 'альбома', 'альбомов') → «альбомов».
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return one
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few
  return many
}
