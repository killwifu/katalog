import { Info } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { api, type AlbumWatermark, type Shop, type WatermarkPosition } from '../api'
import { Icon } from '../lib/icons'
import { WATERMARK_POSITIONS as POSITIONS } from '../lib/watermark'

// Водяной знак — настройка витрины, а не этой загрузки, поэтому
// переключатель сохраняется сразу: оставь мы его «до нажатия Загрузить»,
// фото первой пачки обработались бы ещё со старым значением.
// Знак магазина по умолчанию — от него отталкиваются окна альбома.
export function shopWatermark(shop: Shop): AlbumWatermark {
  const saved = shop.settings.watermark
  return { enabled: Boolean(saved?.enabled), position: saved?.position ?? 'br' }
}

// value/onChange — знак конкретного альбома (окна «Новый альбом» и
// «Редактировать альбом», макет 11–12): сохраняется вместе с альбомом.
// Без них — общий знак магазина, сохраняется сразу (окно загрузки).
export function WatermarkControl({
  shop,
  disabled,
  value,
  onChange,
}: {
  shop: Shop
  disabled: boolean
  value?: AlbumWatermark
  onChange?: (next: AlbumWatermark) => void
}) {
  const queryClient = useQueryClient()
  const saved = shop.settings.watermark
  const [ownEnabled, setEnabled] = useState(Boolean(saved?.enabled && saved.text))
  const [ownPosition, setPosition] = useState<WatermarkPosition>(saved?.position ?? 'br')
  const [tip, setTip] = useState(false)
  const tipId = useId()
  const [error, setError] = useState(false)
  const enabled = value ? value.enabled : ownEnabled
  const position = value ? value.position : ownPosition

  const save = (next: { enabled: boolean; position: WatermarkPosition }) => {
    if (onChange) {
      onChange(next)
      return
    }
    const before = { enabled, position }
    setEnabled(next.enabled)
    setPosition(next.position)
    setError(false)
    api
      .updateSettings(shop.id, {
        ...shop.settings,
        watermark: {
          // Текст знака задаётся в настройках витрины; если его там ещё
          // нет, подписываем названием витрины — как обещает подсказка.
          text: saved?.text || shop.name.slice(0, 64),
          opacity: saved?.opacity || 0.55,
          ...next,
        },
      })
      .then(() => void queryClient.invalidateQueries({ queryKey: ['shops'] }))
      .catch(() => {
        // Не сохранилось — возвращаем как было: переключатель, который
        // показывает «включён» при выключенном знаке, хуже ошибки.
        setEnabled(before.enabled)
        setPosition(before.position)
        setError(true)
      })
  }

  const tipText = onChange
    ? 'Знак для фото этого альбома. Текст — подпись витрины из настроек. Накладывается на новые фото; уже загруженные не меняются.'
    : 'Знаком служит название витрины — текст можно поменять в настройках. Накладывается на новые фото; уже загруженные не меняются.'

  return (
    <div className="wm">
      <div>
        <span className="wm__label">
          Водяной знак{' '}
          {/* Подсказка по нажатию, а не только по наведению: на телефоне
              наводить нечем, а «title» не читается с клавиатуры. */}
          <button
            type="button"
            className="wm__info"
            aria-label="Что такое водяной знак"
            aria-expanded={tip}
            aria-controls={tipId}
            title={tipText}
            onClick={() => setTip((v) => !v)}
          >
            <Icon as={Info} size={14} />
          </button>
        </span>
        {tip && (
          <p className="wm__tip" id={tipId}>
            {tipText}
          </p>
        )}
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(e) => save({ enabled: e.target.checked, position })}
          />
          <span>{enabled ? 'Включён' : 'Выключен'}</span>
        </label>
        {error && <p className="wm__err">Не сохранилось</p>}
      </div>
      <div>
        <span className="wm__label">Положение</span>
        <div className="wmgrid" role="radiogroup" aria-label="Положение водяного знака">
          {POSITIONS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={position === p.id}
              aria-label={p.label}
              title={p.label}
              disabled={disabled || !enabled}
              onClick={() => save({ enabled, position: p.id })}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
