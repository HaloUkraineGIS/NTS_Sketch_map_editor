import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Мітка збірки для перевірки свіжості бандла в консолі: __SKETCHMAP_BUILD.
// Оновлювати при кожному значимому фіксі експорту/рендера.
;(window as unknown as { __SKETCHMAP_BUILD?: string }).__SKETCHMAP_BUILD = '2026-10-09 insets-v2'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
