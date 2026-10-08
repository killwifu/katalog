// Tab не должен уводить фокус из открытого окна на страницу под ним:
// с клавиатуры продавец «проваливался» в меню и карточки за подложкой и
// терял окно из виду. Окон больше десятка, поэтому ловим Tab один раз на
// документе и держим фокус в самой верхней подложке (вложенное окно
// подтверждения идёт в DOM после родительского).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function installModalFocusTrap(): void {
  // Куда вернуть фокус после закрытия: последний элемент вне окон.
  // Иначе он падал на body, и с клавиатуры приходилось начинать
  // с начала страницы.
  let opener: HTMLElement | null = null
  let open = false
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement
    if (!t.closest('.modal__back')) opener = t
  })
  let layers = 0
  new MutationObserver(() => {
    const all = document.querySelectorAll<HTMLElement>('.modal__back')
    const nowOpen = all.length > 0
    // Открылось новое окно, а фокус остался на кнопке за подложкой (окна без
    // поля с autoFocus: «Загрузить фото», «Изменить доступ», «Поделиться»,
    // подтверждения). Переносим внутрь: на поле ввода, иначе на первую кнопку
    // после крестика — в подтверждениях это «Отмена», а не необратимое действие.
    if (all.length > layers) {
      const top = all[all.length - 1]
      requestAnimationFrame(() => {
        if (!top.isConnected || top.contains(document.activeElement)) return
        const items = [...top.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
        // Сначала поле ввода (поиск, ссылка), потом первая кнопка не-крестик.
        const field = items.find((el) => el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea, select'))
        ;(field ?? items.find((el) => !el.matches('.modal__x, .placechip__x')) ?? items[0])?.focus()
      })
    }
    layers = all.length
    if (open && !nowOpen) {
      const active = document.activeElement
      if ((!active || active === document.body) && opener?.isConnected) opener.focus()
    }
    open = nowOpen
  }).observe(document.body, { childList: true, subtree: true })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const layers = document.querySelectorAll<HTMLElement>('.modal__back')
    const top = layers[layers.length - 1]
    if (!top) return
    const items = [...top.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    )
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (!top.contains(active)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  })
}
