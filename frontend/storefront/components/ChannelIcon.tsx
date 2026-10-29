import type { Channel } from '@/lib/links'

// Значки мессенджеров (макет 15 · «Контакты», «Написать продавцу»):
// упрощённые фирменные формы в фирменных цветах, без внешних картинок.
export function ChannelIcon({ channel, size = 36 }: { channel: Channel; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 36 36', 'aria-hidden': true as const, className: 'chico' }
  switch (channel) {
    case 'telegram':
      return (
        <svg {...common}>
          <circle cx="18" cy="18" r="18" fill="#2AABEE" />
          <path d="M8.5 17.4l17-6.6c.8-.3 1.5.2 1.2 1.4l-2.9 13.6c-.2 1-.8 1.2-1.6.8l-4.4-3.3-2.1 2.1c-.2.2-.4.4-.9.4l.3-4.5 8.2-7.4c.4-.3-.1-.5-.6-.2l-10.1 6.4-4.4-1.4c-.9-.3-1-1 .3-1.3z" fill="#fff" />
        </svg>
      )
    case 'whatsapp':
      return (
        <svg {...common}>
          <rect width="36" height="36" rx="8" fill="#25D366" />
          <path d="M18 8.5a9.5 9.5 0 0 0-8.2 14.3L8.5 27.5l4.8-1.3A9.5 9.5 0 1 0 18 8.5z" fill="none" stroke="#fff" strokeWidth="1.8" />
          <path d="M14.6 13.6c.3-.6.6-.6.9-.6h.6c.2 0 .5 0 .7.5l.9 2.1c.1.2.1.4 0 .6l-.5.7c-.2.2-.2.4 0 .7.7 1.2 1.7 2.1 2.9 2.7.3.1.5.1.6-.1l.7-.8c.2-.2.4-.3.7-.2l2 .9c.3.2.5.3.5.5 0 .9-.6 1.8-1.5 2-.9.3-2.4.1-4.4-1.1-1.8-1.1-3.2-2.8-3.8-4.1-.6-1.4-.4-2.6.2-3.4z" fill="#fff" />
        </svg>
      )
    case 'vk':
      return (
        <svg {...common}>
          <circle cx="18" cy="18" r="18" fill="#0077FF" />
          <path d="M19 24.5c-6.2 0-9.7-4.3-9.9-11.4h3.1c.1 5.2 2.4 7.4 4.2 7.9v-7.9h2.9v4.5c1.8-.2 3.7-2.2 4.3-4.5h2.9c-.5 2.8-2.5 4.8-4 5.6 1.5.7 3.8 2.4 4.7 5.8h-3.2c-.7-2.2-2.4-3.9-4.7-4.1v4.1H19z" fill="#fff" />
        </svg>
      )
    case 'max':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="chmax" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#3BB5FF" />
              <stop offset=".55" stopColor="#4A3CF5" />
              <stop offset="1" stopColor="#9A3CF0" />
            </linearGradient>
          </defs>
          <rect width="36" height="36" rx="9" fill="url(#chmax)" />
          <path d="M18.3 9.5a8.4 8.4 0 0 0-8.4 8.6c0 2 .5 3.7.9 5.4.3 1.3.3 2.4 1.4 2.4.9 0 1.6-.8 2.5-.8 1 .7 2.2 1.1 3.6 1.1a8.4 8.4 0 1 0 0-16.7z" fill="#fff" />
          <circle cx="18.3" cy="18" r="3.6" fill="#4A3CF5" />
        </svg>
      )
    case 'avito':
      return (
        <svg {...common}>
          <circle cx="12" cy="24" r="6" fill="#00D26A" />
          <circle cx="25" cy="13" r="5" fill="#00AAFF" />
          <circle cx="25.5" cy="25" r="3.6" fill="#FF4053" />
          <circle cx="11.5" cy="12.5" r="2.6" fill="#965EEB" />
        </svg>
      )
  }
}
