import { useBlocker } from '@tanstack/react-router'
import { useEffect } from 'react'

// Защита несохранённых правок.
//
// Формы кабинета держат черновик в локальном состоянии, а оно исчезает
// вместе с компонентом при уходе с маршрута. Продавец набирал описание,
// переключился посмотреть альбомы — и текст пропал молча, без следа.
// Узнать об этом можно было только открыв витрину.
//
// Перехватываем оба пути ухода: переход внутри приложения (роутер)
// и закрытие вкладки (beforeunload). Второй показывает системный диалог
// браузера, текст задать нельзя — это ограничение платформы.
export function useUnsavedGuard(dirty: boolean): void {
  useBlocker({
    shouldBlockFn: () =>
      !window.confirm('Изменения не сохранены. Уйти со страницы и потерять их?'),
    enableBeforeUnload: false,
    disabled: !dirty,
  })

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Значение игнорируется современными браузерами, но требуется,
      // чтобы диалог вообще показался.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
