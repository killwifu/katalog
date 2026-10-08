import { ENTRIES } from '../(marketing)/updates/entries'

// Последние записи ленты обновлений — для блока «Объявления» в кабинете
// продавца (макет 09). Источник один с публичной страницей /updates:
// заводить вторую копию текстов в кабинете значило бы дать им разойтись.
export const dynamic = 'force-static'

export function GET() {
  // Новые записи идут в конце списка; кабинету нужны свежие сверху.
  const latest = [...ENTRIES]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 5)
    .map(({ id, date, title }) => ({ id, date, title }))
  return Response.json(latest)
}
