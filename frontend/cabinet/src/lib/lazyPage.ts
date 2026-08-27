import { lazy, type ComponentType } from 'react'

const RELOADED_KEY = 'katalog:chunk-reloaded'

// Ленивая страница, переживающая деплой.
//
// После выкладки имена чанков меняются, а у продавца в открытой вкладке
// остаётся старый index.html. Клик по такой странице запрашивает чанк,
// которого на сервере уже нет, — и переход падает. Чинить это только
// на сервере нельзя: 404 вместо HTML честнее, но пользователю всё равно
// показывается ошибка.
//
// Поэтому первый сбой загрузки трактуем как «вышла новая версия»
// и перезагружаем страницу — она подтянет свежий index.html вместе
// с актуальными именами чанков.
//
// Флаг в sessionStorage не даёт зациклиться: если чанк не грузится
// и после перезагрузки, причина другая (сеть, сломанная сборка),
// и ошибку нужно показать, а не крутить бесконечный reload.
export function lazyPage<T extends ComponentType<Record<string, never>>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const mod = await load()
      sessionStorage.removeItem(RELOADED_KEY)
      return mod
    } catch (err) {
      if (!sessionStorage.getItem(RELOADED_KEY)) {
        sessionStorage.setItem(RELOADED_KEY, '1')
        location.reload()
        // Возвращаем висящий промис: страница уже перезагружается,
        // показывать ошибку на долю секунды незачем.
        return new Promise<never>(() => {})
      }
      throw err
    }
  })
}
