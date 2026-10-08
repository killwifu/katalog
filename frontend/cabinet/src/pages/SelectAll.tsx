import { useEffect, useRef } from 'react'

// «Выбрать все» в шапке сетки (макеты 10 и 13 · select all): пока что-то
// выбрано, но не всё — чекбокс «частично» (минус), а подпись меняется на
// «Выбрано: N».
export function SelectAll({
  picked,
  all,
  disabled,
  hidden,
  onToggle,
}: {
  picked: number
  all: boolean
  disabled?: boolean
  hidden?: boolean
  onToggle: () => void
}) {
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = picked > 0 && !all
  }, [picked, all])
  return (
    <label hidden={hidden} className="selall">
      <input ref={box} type="checkbox" checked={all} onChange={onToggle} disabled={disabled} />
      {picked > 0 ? `Выбрано: ${picked}` : 'Выбрать все'}
    </label>
  )
}
