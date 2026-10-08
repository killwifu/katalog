import { useState } from 'react'

// Защита от повторного нажатия: пока предыдущий вызов не закончился,
// следующие игнорируются. Кнопка блокируется только после перерисовки, и
// быстрый двойной клик успевал запустить действие дважды — так появлялись
// два одинаковых альбома. Флаг живёт в замыкании, созданном один раз на
// компонент; enter/leave вызываются только из обработчиков, не в рендере.
//
//   const flight = useSingleFlight()
//   const save = async () => {
//     if (!flight.enter()) return
//     try { … } finally { flight.leave() }
//   }
export function useSingleFlight(): { enter: () => boolean; leave: () => void } {
  const [flight] = useState(() => {
    let busy = false
    return {
      enter: () => {
        if (busy) return false
        busy = true
        return true
      },
      leave: () => {
        busy = false
      },
    }
  })
  return flight
}
