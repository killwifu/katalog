import { Info } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { api, type AlbumWatermark, type Shop, type WatermarkPosition } from '../api'
import { Icon } from '../lib/icons'
import { WATERMARK_POSITIONS as POSITIONS, WATERMARK_TILE, toggleWatermarkCell, watermarkCells } from '../lib/watermark'

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
  disabled: busy,
  value,
  onChange,
}: {
  shop: Shop
  disabled: boolean
  value?: AlbumWatermark
  onChange?: (next: AlbumWatermark) => void
}) {
  // На Бесплатном знак недоступен (макеты 10–12, 17 · «Free-тариф»):
  // переключатель неактивен, под блоком — подсказка со сменой тарифа.
  // Знак, включённый на платном, продолжает работать.
  const free = shop.plan === 'free'
  const disabled = busy || free
  const queryClient = useQueryClient()
  const saved = shop.settings.watermark
  const [ownEnabled, setEnabled] = useState(Boolean(saved?.enabled && saved.text))
  const [ownPosition, setPosition] = useState<WatermarkPosition>(saved?.position ?? 'br')
  const [tip, setTip] = useState(false)
  const tipId = useId()
  const [error, setError] = useState(false)
  // Подсказка закрывается нажатием мимо (макет 10 · Tablet · «по нажатию»).
  useEffect(() => {
    if (!tip) return
    const hide = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.wm__info')) setTip(false)
    }
    document.addEventListener('pointerdown', hide)
    return () => document.removeEventListener('pointerdown', hide)
  }, [tip])
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
    ? 'Знак для фото этого альбома. Текст — подпись витрины из настроек. После сохранения применяется и к уже загруженным фото альбома.'
    : 'В качестве водяного знака используется название вашего аккаунта. Положение надписи задается в меню справа'

  return (
    <>
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
            title={onChange ? tipText : undefined}
            onClick={() => setTip((v) => !v)}
          >
            <Icon as={Info} size={14} />
          </button>
          {/* Окно загрузки (макет 10): тёмная подсказка по наведению или нажатию. */}
          {!onChange && (
            <span className={`wm__pop ${tip ? 'wm__pop--on' : ''}`} role="tooltip" id={tipId}>
              {tipText}
            </span>
          )}
        </span>
        {tip && onChange && (
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
        <WatermarkGrid position={position} disabled={disabled || !enabled} onChange={(p) => save({ enabled, position: p })} />
      </div>
    </div>
    {free && <WatermarkPaidHint />}
    </>
  )
}

export function WatermarkPaidHint() {
  return (
    <p className="hint hint--i">
      <span>
        Водяной знак доступен на платных тарифах.{' '}
        <Link to="/billing" className="font-medium text-brand">
          Сменить тариф
        </Link>
      </span>
    </p>
  )
}

// Сетка положения знака: можно отметить несколько клеток или «По всей
// области» (правка 3 из списка 26.10). Общая для окон и настроек витрины.
export function WatermarkGrid({
  position,
  disabled,
  onChange,
}: {
  position: WatermarkPosition | undefined
  disabled: boolean
  onChange: (next: WatermarkPosition) => void
}) {
  const tile = position === WATERMARK_TILE
  const cells = watermarkCells(position)
  return (
    <div className="wmpick">
      <div className="wmgrid" role="group" aria-label="Положение водяного знака">
        {POSITIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="checkbox"
            aria-checked={cells.includes(p.id)}
            aria-label={p.label}
            title={p.label}
            disabled={disabled}
            onClick={() => onChange(toggleWatermarkCell(position, p.id))}
          />
        ))}
      </div>
      <label className="wmpick__tile">
        <input
          type="checkbox"
          checked={tile}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? WATERMARK_TILE : 'br')}
        />
        По всей области
      </label>
    </div>
  )
}
