'use client'

// «Пожаловаться на контент» уносит в форму адрес страницы, с которой
// пришли (с открытым фото — вместе с ?p=). Раньше правообладатель попадал
// в пустую форму и копировал ссылку на фото вручную.
const OWN_PAGES = ['/', '/abuse', '/terms', '/privacy', '/content-policy', '/pricing']

export function ReportLink() {
  return (
    <a
      href="/abuse"
      onClick={(e) => {
        if (OWN_PAGES.includes(location.pathname)) return
        e.currentTarget.href = `/abuse?url=${encodeURIComponent(location.href)}`
      }}
    >
      Пожаловаться на контент
    </a>
  )
}
