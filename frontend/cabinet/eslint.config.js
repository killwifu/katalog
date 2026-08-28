import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  ...tseslint.configs.recommended,
  // Правила хуков — не стилистика: вызов хука после раннего return
  // роняет страницу целиком (React #310). Ловится только линтером.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
)
