import { CircleAlert } from 'lucide-react'
import { Icon } from './icons'

// Строчная ошибка блока (макет 09 · «Ошибка загрузки статистики»): красная
// иконка, серый текст и синее «Повторить».
export function InlineError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <p className="inlerr" role="alert">
      <Icon as={CircleAlert} size={18} />
      {text}
      <button onClick={onRetry}>Повторить</button>
    </p>
  )
}
