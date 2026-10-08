import { useEffect, useState } from 'react'
import { heicPreviewURL, isHeic } from '../lib/heicPreview'

// Миниатюра выбранного файла — общая для окна загрузки и создания альбома.
export function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let revoke: string | null = null
    let alive = true
    // Chrome и Firefox HEIC не декодируют — без отдельного декодера вместо
    // снимка была бы пустая плитка.
    const preview = isHeic({ name: file.name, type: file.type })
      ? heicPreviewURL(file)
      : Promise.resolve(file.type.startsWith('image/') ? URL.createObjectURL(file) : null)
    void preview.then((made) => {
      if (made?.startsWith('blob:')) revoke = made
      if (alive) setUrl(made)
      else if (revoke) URL.revokeObjectURL(revoke)
    })
    return () => {
      alive = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [file])
  return url ? <img src={url} alt="" /> : <span className="uptile2__blank" aria-hidden="true" />
}
