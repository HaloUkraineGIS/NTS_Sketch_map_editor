import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Мітка збірки для перевірки свіжості бандла в консолі: __SKETCHMAP_BUILD.
// Оновлювати при кожному значимому фіксі експорту/рендера.
;(window as unknown as { __SKETCHMAP_BUILD?: string }).__SKETCHMAP_BUILD = '2026-10-23 preload-retry'

const PRELOAD_RETRY_KEY = 'sketchmap:preload-retry-at'
const PRELOAD_RETRY_COOLDOWN_MS = 30_000

/**
 * Після нового деплою GitHub Pages старі hashed-чанки можуть зникнути.
 * Якщо вкладка відкрита зі старим index.html, лінивий import() падає з
 * "Failed to fetch dynamically imported module". Один раз перезавантажуємо
 * сторінку, щоб отримати свіжий index.html; повторні падіння не зациклюємо,
 * а віддаємо звичайному error-стану додатка.
 */
function installPreloadErrorHandler() {
  window.addEventListener('vite:preloadError', (event) => {
    const now = Date.now()

    let lastRetry: number | null = null
    try {
      lastRetry = Number(window.sessionStorage.getItem(PRELOAD_RETRY_KEY) ?? 0)
    } catch {
      // sessionStorage може бути недоступним у приватному/обмеженому режимі.
    }
    if (lastRetry !== null && Number.isFinite(lastRetry) && now - lastRetry < PRELOAD_RETRY_COOLDOWN_MS) {
      return
    }

    let stored = false
    try {
      window.sessionStorage.setItem(PRELOAD_RETRY_KEY, String(now))
      stored = true
    } catch {
      // Без сховища не можемо гарантувати захист від циклу — не reload'имо.
    }
    if (!stored) return

    event.preventDefault()
    window.location.reload()
  })
}

installPreloadErrorHandler()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
