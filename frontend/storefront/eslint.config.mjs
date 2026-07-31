import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.next', 'next-env.d.ts'] },
  ...tseslint.configs.recommended,
)
