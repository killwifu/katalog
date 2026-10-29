// Deep-links в мессенджеры продавца с шаблоном сообщения.
// Формат contacts (jsonb магазина): { telegram: 'handle', whatsapp: '7999...',
// vk: 'handle', max: 'handle или полный URL', avito: 'avito.ru/brands/…' }.

export type Channel = 'telegram' | 'whatsapp' | 'vk' | 'max' | 'avito'

export const CHANNEL_LABELS: Record<Channel, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  avito: 'Авито',
}

const DEFAULT_TEMPLATE = 'Здравствуйте! Интересует: {caption}'

// Текст сообщения продавец пишет в «Контактах» свободно (макет 16) — без
// {caption} подпись фото добавляется отдельной строкой: иначе продавец не
// узнает, о каком товаре речь.
export function messageText(template: string, caption: string): string {
  const t = template || DEFAULT_TEMPLATE
  if (t.includes('{caption}')) return t.replaceAll('{caption}', caption || '')
  return caption ? `${t}\n${caption}` : t
}

// Полную ссылку продавец вставить может (у MAX это обычный сценарий), но
// только на сам мессенджер. Иначе кнопка «VK» на витрине уводила бы куда
// угодно: своих ссылок продавцу в каталоге больше поставить негде, и это
// был бы готовый канал для фишинга под именем площадки.
const ALLOWED_HOSTS: Record<'vk' | 'max', string[]> = {
  vk: ['vk.me', 'vk.com', 'm.vk.com'],
  max: ['max.ru', 'm.max.ru'],
}

function fullLink(channel: 'vk' | 'max', value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return ALLOWED_HOSTS[channel].includes(host) ? url.toString() : null
  } catch {
    return null
  }
}

export function contactHref(channel: Channel, value: string, text: string): string {
  const v = value.trim().replace(/^@/, '')
  const enc = encodeURIComponent(text)
  switch (channel) {
    case 'telegram':
      // Продавец мог сохранить ссылку целиком (t.me/ник) — берём из неё ник,
      // иначе кнопка вела на t.me/https%3A…
      // «+» у номера (t.me/+79991234567) должен остаться буквальным.
      return `https://t.me/${encodeURIComponent(telegramHandle(v)).replace(/^%2B/, '+')}?text=${enc}`
    case 'whatsapp':
      return `https://wa.me/${v.replace(/\D/g, '')}?text=${enc}`
    case 'vk':
      // vk.me не поддерживает предзаполнение текста.
      return fullLink('vk', v) ?? `https://vk.me/${encodeURIComponent(v)}`
    case 'max':
      return fullLink('max', v) ?? `https://max.ru/${encodeURIComponent(v)}`
    case 'avito':
      // Только профиль или магазин продавца; текст Авито не подставляет.
      return avitoLink(v) ?? 'https://www.avito.ru/'
  }
}

// Ссылка на avito.ru/user|brands/… (сервер проверяет то же при сохранении).
function avitoLink(v: string): string | null {
  const m = v.match(/^(?:https?:\/\/)?(?:www\.|m\.)?avito\.ru\/((?:user|brands)\/[^\s]+)$/i)
  return m ? `https://www.avito.ru/${m[1]}` : null
}

function telegramHandle(v: string): string {
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/@?([^/?#]+)/i)
  return m ? m[1] : v
}

// Каналы магазина в фиксированном порядке (contacts может содержать мусор).
export function shopChannels(contacts: Record<string, string>): { channel: Channel; value: string }[] {
  const order: Channel[] = ['telegram', 'whatsapp', 'vk', 'max', 'avito']
  return order
    .filter((ch) => typeof contacts[ch] === 'string' && contacts[ch].trim() !== '')
    .map((ch) => ({ channel: ch, value: contacts[ch] }))
}
