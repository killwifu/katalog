import AwsS3 from '@uppy/aws-s3'
import Uppy from '@uppy/core'
import ru_RU from '@uppy/locales/lib/ru_RU'
import { ApiError, api } from '../api'
import { heicPreviewURL, isHeic } from './heicPreview'

// Причины отказа в presign — машинные коды бэкенда. Показываем человеческий
// текст: «не удалось загрузить» без объяснения выглядит как поломка сервиса.
export const QUOTA_REASONS: Record<string, string> = {
  photo_quota_exceeded: 'достигнут лимит фотографий на тарифе',
  quota_exceeded: 'закончилось место в хранилище',
  subscription_inactive: 'подписка неактивна, загрузка приостановлена',
}

export type UploadOutcome = {
  uploaded: number
  total: number
  reason?: string
  // confirmFailed — файлы доехали в S3, но подтвердить их не удалось.
  // Молчать здесь нельзя: место уже занято, а обработка не начата.
  confirmFailed?: number
}

type Options = {
  shopId: string
  albumId: string
  onBatchConfirmed: () => void
  onOutcome?: (outcome: UploadOutcome) => void
}

// Один конструктор на загрузку в альбом и на онбординг: настройки ограничений,
// presign и подтверждения обязаны совпадать, иначе пути загрузки разъедутся.
export function createPhotoUppy({ shopId, albumId, onBatchConfirmed, onOutcome }: Options): Uppy {
  const uppy = new Uppy({
    locale: ru_RU,
    restrictions: {
      // Ровно то, что принимает сервер (jpeg/png/webp/heic). Маска
      // image/* пропускала GIF, BMP, TIFF и SVG: файл целиком уезжал
      // в S3 и отваливался уже на обработке — трафик потрачен, а
      // продавец видит «не удалось» без объяснения. На телефоне это
      // особенно обидно.
      allowedFileTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        '.jpg',
        '.jpeg',
        '.png',
        '.webp',
        '.heic',
        '.heif',
      ],
      maxFileSize: 50 * 1024 * 1024,
    },
  }).use(AwsS3, {
    shouldUseMultipart: false,
    async getUploadParameters(file) {
      try {
        const { photo_id, url } = await api.presign(shopId, albumId, file.size ?? 0)
        uppy.setFileMeta(file.id, { photoId: photo_id })
        return { method: 'PUT', url, headers: {} }
      } catch (e) {
        // Лимит валит только этот файл, остальные продолжают грузиться:
        // отказ целиком заставил бы продавца отбирать фото вручную заранее.
        if (e instanceof ApiError && QUOTA_REASONS[e.code]) {
          throw new Error(QUOTA_REASONS[e.code])
        }
        throw e
      }
    },
  })

  // Превью HEIC: Uppy рисует миниатюру через canvas, а Chrome и Firefox
  // HEIC не декодируют — без этого продавец видит пустые плитки.
  uppy.on('file-added', (file) => {
    if (!isHeic({ name: file.name, type: file.type })) return
    void heicPreviewURL(file.data as Blob).then((preview) => {
      if (preview) uppy.setFileState(file.id, { preview })
    })
  })

  uppy.on('complete', (result) => {
    const ok = result.successful ?? []
    const failed = result.failed ?? []
    if (failed.length > 0 && onOutcome) {
      const reason = Object.values(QUOTA_REASONS).find((r) => failed.some((f) => f.error?.includes(r)))
      onOutcome({ uploaded: ok.length, total: ok.length + failed.length, reason })
    }
    const ids = ok
      .map((f) => (f.meta as { photoId?: string }).photoId)
      .filter((id): id is string => Boolean(id))
    if (ids.length === 0) return

    void api
      .confirm(shopId, ids)
      .then((res) => {
        onBatchConfirmed()
        // Подтверждение частичное: у каждого фото свой статус. Молча
        // потерять несколько из пачки — худший исход: продавец считает,
        // что загрузил всё.
        const failed = (res.results ?? []).filter((r) => r.status !== 'processing')
        if (failed.length > 0) {
          onOutcome?.({
            uploaded: ids.length - failed.length,
            total: ids.length,
            confirmFailed: failed.length,
          })
        }
      })
      .catch(() => {
        // Файлы уже в S3 и занимают место, но обработка не запущена.
        // Без этой ветки они навсегда оставались в статусе uploading —
        // на боевом стенде таких накопилось шесть штук за неделю.
        onOutcome?.({ uploaded: 0, total: ids.length, confirmFailed: ids.length })
      })
  })

  return uppy
}
