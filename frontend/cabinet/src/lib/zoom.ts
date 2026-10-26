// Масштаб страницы (html { zoom } на широких мониторах, см. index.css).
// Координаты указателя и getBoundingClientRect — в экранных пикселях, а
// длины в стилях элемента — в CSS-пикселях до масштаба: делим на него.
export function pageZoom(): number {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1
}
