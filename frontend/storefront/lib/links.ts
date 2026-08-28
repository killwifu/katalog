// Deep-links в мессенджеры продавца с шаблоном сообщения.
// Формат contacts (jsonb магазина): { telegram: 'handle', whatsapp: '7999...',
// vk: 'handle', max: 'handle или полный URL' }.

export type Channel = 'telegram' | 'whatsapp' | 'vk' | 'max'

export const CHANNEL_LABELS: Record<Channel, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
}

const DEFAULT_TEMPLATE = 'Здравствуйте! Интересует: {caption}'

export function messageText(template: string, caption: string): string {
  const t = template || DEFAULT_TEMPLATE
  return t.replaceAll('{caption}', caption || '')
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
      return `https://t.me/${encodeURIComponent(v)}?text=${enc}`
    case 'whatsapp':
      return `https://wa.me/${v.replace(/\D/g, '')}?text=${enc}`
    case 'vk':
      // vk.me не поддерживает предзаполнение текста.
      return fullLink('vk', v) ?? `https://vk.me/${encodeURIComponent(v)}`
    case 'max':
      return fullLink('max', v) ?? `https://max.ru/${encodeURIComponent(v)}`
  }
}

// Каналы магазина в фиксированном порядке (contacts может содержать мусор).
export function shopChannels(contacts: Record<string, string>): { channel: Channel; value: string }[] {
  const order: Channel[] = ['telegram', 'whatsapp', 'vk', 'max']
  return order
    .filter((ch) => typeof contacts[ch] === 'string' && contacts[ch].trim() !== '')
    .map((ch) => ({ channel: ch, value: contacts[ch] }))
}
