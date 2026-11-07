import AwsS3 from '@uppy/aws-s3'
import Uppy from '@uppy/core'
import ru_RU from '@uppy/locales/lib/ru_RU'
import { ApiError, api, type ConfirmResult } from '../api'
import { heicPreviewURL, isHeic } from './heicPreview'
import { bump } from './inflight'

// Причины отказа в presign — машинные коды бэкенда. Показываем человеческий
// текст: «не удалось загрузить» без объяснения выглядит как поломка сервиса.
export const ALBUM_GONE = 'Альбом удалён'

export const QUOTA_REASONS: Record<string, string> = {
  photo_quota_exceeded: 'достигнут лимит фотографий на тарифе',
  quota_exceeded: 'закончилось место в хранилище',
  subscription_inactive: 'подписка неактивна, загрузка приостановлена',
}

type Options = {
  shopId: string
  albumId: string
}

// Один конструктор на загрузку в альбом и на онбординг: настройки ограничений,
// presign и подтверждения обязаны совпадать, иначе пути загрузки разъедутся.
// Сервер принимает не больше 200 фото за одно подтверждение, а пачка в
// 300 — обычное дело. Новые фото сервер ставит сразу после обложки, поэтому
// части уходят с конца: последняя встаёт первой, каждая следующая — перед
// ней, и порядок выбора файлов сохраняется на всю пачку.
const CONFIRM_CHUNK = 200

async function confirmInChunks(shopId: string, ids: string[]): Promise<ConfirmResult[]> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CONFIRM_CHUNK) chunks.push(ids.slice(i, i + CONFIRM_CHUNK))
  const results: ConfirmResult[] = []
  for (const chunk of chunks.reverse()) {
    try {
      const res = await api.confirm(shopId, chunk)
      results.unshift(...chunk.map((photo_id) =>
        res.results?.find((r) => r.photo_id === photo_id) ?? { photo_id, status: 'error' },
      ))
    } catch (e) {
      // Успех предыдущих частей сохраняется даже при отказе следующей.
      results.unshift(...chunk.map((photo_id) => ({
        photo_id, status: 'error', code: e instanceof ApiError ? e.code : undefined,
      })))
    }
  }
  return results
}

export function createPhotoUppy({ shopId, albumId }: Options) {
  // Файлы, под которые сервер уже выдал ссылку (и завёл фото).
  const presigned = new Map<string, string>()
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
      maxFileSize: 10 * 1024 * 1024,
    },
  }).use(AwsS3, {
    shouldUseMultipart: false,
    async getUploadParameters(file) {
      try {
        const { photo_id, url } = await api.presign(shopId, albumId, file.size ?? 0)
        // Пока ждали ссылку, загрузку отменили: файла в Uppy уже нет, а
        // сервер фото завёл. Убираем его сразу — обработчик отмены о нём
        // не знает, запрос тогда ещё не вернулся.
        if (!uppy.getFile(file.id)) {
          void api.deletePhoto(photo_id).catch(() => {})
          throw new Error('upload cancelled')
        }
        uppy.setFileMeta(file.id, { photoId: photo_id })
        presigned.set(file.id, photo_id)
        return { method: 'PUT', url, headers: {} }
      } catch (e) {
        // Лимит валит только этот файл, остальные продолжают грузиться:
        // отказ целиком заставил бы продавца отбирать фото вручную заранее.
        if (e instanceof ApiError && QUOTA_REASONS[e.code]) {
          throw new Error(QUOTA_REASONS[e.code])
        }
        // Альбом удалили, пока окно было открыто (другая вкладка, телефон):
        // это не сбой сети, и «Повторить» не поможет.
        if (e instanceof ApiError && e.status === 404) throw new Error(ALBUM_GONE)
        throw e
      }
    },
  })

  // Превью HEIC: Uppy рисует миниатюру через canvas, а Chrome и Firefox
  // HEIC не декодируют — без этого продавец видит пустые плитки.
  uppy.on('file-added', (file) => {
    if (!isHeic({ name: file.name, type: file.type })) return
    void heicPreviewURL(file.data as Blob).then((preview) => {
      // Превью HEIC декодируется долго: к этому моменту файл могли убрать,
      // а загрузку — закончить и закрыть (uppy.destroy). setFileState на
      // исчезнувший файл бросал необработанную ошибку в консоль.
      if (preview && uppy.getFile(file.id)) uppy.setFileState(file.id, { preview })
    })
  })

  // Что уже лежит в S3 и что из этого подтверждено. Подтверждать нужно
  // и при отмене: «Остановить» посреди пачки иначе оставляло доехавшие
  // файлы в статусе uploading — место занято, обработка не начата.
  const uploaded = new Map<string, string>()
  uppy.on('upload-success', (file) => {
    if (!file) return
    const photoId = (uppy.getFile(file.id)?.meta as { photoId?: string } | undefined)?.photoId
    if (photoId) uploaded.set(file.id, photoId)
  })

  const confirmUploaded = async (ids: string[]) => {
    if (ids.length === 0) return []
    bump(1)
    try {
      return await confirmInChunks(shopId, ids)
    } finally {
      bump(-1)
    }
  }

  // Отмена убирает только недоехавшие файлы; доехавшие подтверждает uploadRun.
  uppy.on('cancel-all', () => {
    // Ссылка выдана, а файл не доехал: остановили или сорвалась сеть.
    // Сервер уже завёл под него фото в статусе uploading — без отмены оно
    // сутки висело бы в альбоме плиткой «Обработка…» и занимало лимит.
    for (const [fileId, photoId] of presigned) {
      if (!uploaded.has(fileId)) void api.deletePhoto(photoId).catch(() => {})
    }
    presigned.clear()
  })

  return { uppy, confirmUploaded }
}
