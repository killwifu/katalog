// Копирование в буфер обмена. navigator.clipboard есть только в защищённом
// контексте (https или localhost) и может отказать без фокуса страницы;
// тогда — старый способ через скрытое поле и execCommand. Без него на
// стенде по http кнопка «Скопировать ссылку» падала с TypeError.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Пробуем запасной способ ниже.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}
