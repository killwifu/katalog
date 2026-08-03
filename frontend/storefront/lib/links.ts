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

export function contactHref(channel: Channel, value: string, text: string): string {
  const v = value.trim().replace(/^@/, '')
  const enc = encodeURIComponent(text)
  switch (channel) {
    case 'telegram':
      return `https://t.me/${v}?text=${enc}`
    case 'whatsapp':
      return `https://wa.me/${v.replace(/\D/g, '')}?text=${enc}`
    case 'vk':
      // vk.me не поддерживает предзаполнение текста.
      return v.startsWith('http') ? v : `https://vk.me/${v}`
    case 'max':
      return v.startsWith('http') ? v : `https://max.ru/${v}`
  }
}

// Каналы магазина в фиксированном порядке (contacts может содержать мусор).
export function shopChannels(contacts: Record<string, string>): { channel: Channel; value: string }[] {
  const order: Channel[] = ['telegram', 'whatsapp', 'vk', 'max']
  return order
    .filter((ch) => typeof contacts[ch] === 'string' && contacts[ch].trim() !== '')
    .map((ch) => ({ channel: ch, value: contacts[ch] }))
}
