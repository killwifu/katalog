import { createPortal } from 'react-dom'

// Окна (подложка .modal__back, position: fixed) выносим в корень кабинета.
// Отрисованное внутри элемента с transform, filter или container-type окно
// позиционируется относительно него, а не экрана: подтверждение удаления
// категории из меню «⋯» сжималось в квадрат 40×40 у строки дерева.
// Корень — .app, а не body: на нём держатся правила для касаний (.app button).
export function Portal({ children }: { children: React.ReactNode }) {
  const root = document.querySelector('.app') ?? document.body
  return createPortal(children, root)
}
