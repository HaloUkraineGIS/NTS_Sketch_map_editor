import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EvidenceLibrary, LibrarySymbol } from '../symbols/library'
import { NO_CODE_LABEL, symbolDisplayName } from './symbolDisplay'

type Props = {
  library: EvidenceLibrary | null
  /** Точкові знаки, дозволені для шару evidence (той самий список, що був у селекті). */
  symbols: LibrarySymbol[]
  /** Поточний код знака (значення атрибута symbol_code). */
  value: string
  /** Код поза бібліотекою (якщо є в рядку) — окремий рядок вибору. */
  unknownCode: string | null
  onChange: (code: string) => void
}

const MAX_OPTIONS = 60

function previewFor(symbol: LibrarySymbol) {
  if (symbol.hidden) return <span className="symbol-ghost" aria-hidden="true" />
  if (!symbol.svg) return <span className="symbol-dot" aria-hidden="true" />
  return (
    <img
      className="symbol-img"
      src={`${import.meta.env.BASE_URL}${symbol.svg}`}
      alt=""
      aria-hidden="true"
    />
  )
}

/**
 * Швидкий пошук умовного знака замість нативного селекта: фільтр підрядком
 * за назвою або кодом (збіги з початку назви — першими), превʼю в списку,
 * стрілки/Enter/Escape. Вибір пише код в атрибут, показує назву.
 * Список рендериться порталом у body (position:fixed), бо таблиця живе
 * в overflow:auto-контейнері, який обрізав би абсолютну випадайку.
 */
export default function SymbolSearch({ library, symbols, value, unknownCode, onChange }: Props) {
  const [text, setText] = useState(() => symbolDisplayName(library, value))
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Зовнішня зміна коду (вибір, скидання чернетки) — підтягнути текст.
  const [syncedValue, setSyncedValue] = useState(value)
  if (syncedValue !== value) {
    setSyncedValue(value)
    setText(symbolDisplayName(library, value))
    setOpen(false)
  }

  /**
   * Позиція випадайки: донизу, якщо внизу є місце, інакше догори.
   * Повертає false, якщо поле вже не видно (проскролили далеко) — тоді закрити.
   */
  function placeMenu(): boolean {
    const rect = inputRef.current?.getBoundingClientRect()
    if (!rect) return false
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false
    const MIN_H = 120
    const MAX_H = 260
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    let top: number
    let maxHeight: number
    if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
      maxHeight = Math.max(MIN_H, Math.min(MAX_H, spaceBelow - 4))
      top = rect.bottom + 4
    } else {
      maxHeight = Math.max(MIN_H, Math.min(MAX_H, spaceAbove - 4))
      top = Math.max(8, rect.top - 4 - maxHeight)
    }
    const width = Math.max(rect.width, 220)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setAnchor({ top, left, width, maxHeight })
    return true
  }

  function openMenu() {
    if (!placeMenu()) return
    setOpen(true)
    setActive(0)
  }

  // Клік мимо — закрити і повернути текст вибору. Скрол ВСЕРЕДИНІ списку
  // ігнорується (інакше колесико миші зразу закривало б меню); скрол зовні
  // лише перераховує позицію, список лишається відкритим.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!boxRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
        setText(symbolDisplayName(library, value))
      }
    }
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (!placeMenu()) {
        setOpen(false)
        setText(symbolDisplayName(library, value))
      }
    }
    const onResize = () => {
      if (!placeMenu()) {
        setOpen(false)
        setText(symbolDisplayName(library, value))
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, library, value])

  const query = text.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!query) return symbols
    const starts: LibrarySymbol[] = []
    const rest: LibrarySymbol[] = []
    for (const symbol of symbols) {
      const name = symbol.name.toLowerCase()
      const code = symbol.code.toLowerCase()
      if (!name.includes(query) && !code.includes(query)) continue
      if (name.startsWith(query)) starts.push(symbol)
      else rest.push(symbol)
    }
    return [...starts, ...rest]
  }, [symbols, query])

  const shown = matches.slice(0, MAX_OPTIONS)

  function commit(code: string) {
    setText(symbolDisplayName(library, code))
    setOpen(false)
    setActive(0)
    if (code !== value) onChange(code)
  }

  function revert() {
    setText(symbolDisplayName(library, value))
    setOpen(false)
  }

  return (
    <div className="symbol-search-box" ref={boxRef}>
      <input
        ref={inputRef}
        value={text}
        placeholder="Пошук знака…"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls="evidence-symbol-list"
        aria-autocomplete="list"
        onChange={(event) => {
          setText(event.target.value)
          if (!open) openMenu()
          else setActive(0)
        }}
        onFocus={() => {
          // Фокус — показати ВЕСЬ список: поле очищається, фільтр порожній.
          // Скасування (Escape/клік мимо) повертає назву вибраного.
          setText('')
          openMenu()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) openMenu()
            setActive((index) => Math.min(index + 1, Math.max(0, shown.length - 1)))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index) => Math.max(index - 1, 0))
          } else if (event.key === 'Enter') {
            const exact = matches.find(
              (symbol) => symbol.name.toLowerCase() === query || symbol.code.toLowerCase() === query,
            )
            if (!query) revert()
            else if (exact) commit(exact.code)
            else if (shown.length > 0) commit(shown[Math.min(active, shown.length - 1)].code)
          } else if (event.key === 'Escape') {
            revert()
          }
        }}
      />
      {open &&
        anchor &&
        createPortal(
          <div
            className="symbol-search-options"
            id="evidence-symbol-list"
            role="listbox"
            ref={menuRef}
            style={{ top: anchor.top, left: anchor.left, width: anchor.width, maxHeight: anchor.maxHeight }}
          >
            {!query && (
              <div
                role="option"
                aria-selected={value === ''}
                className={`symbol-search-option${value === '' ? ' selected' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  commit('')
                }}
              >
                <span className="symbol-dot symbol-dot-empty" aria-hidden="true" />
                <span>{NO_CODE_LABEL}</span>
              </div>
            )}
            {shown.length === 0 && !unknownCode && (
              <div className="symbol-search-empty">Нічого не знайдено</div>
            )}
            {shown.map((symbol, index) => (
              <div
                key={symbol.code}
                role="option"
                aria-selected={symbol.code === value}
                className={`symbol-search-option${index === active ? ' active' : ''}${symbol.code === value ? ' selected' : ''}${symbol.hidden ? ' is-hidden-code' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  commit(symbol.code)
                }}
                onMouseEnter={() => setActive(index)}
                title={symbol.name}
              >
                {previewFor(symbol)}
                <span>{symbol.name}</span>
              </div>
            ))}
            {unknownCode && (
              <div
                role="option"
                aria-selected={unknownCode === value}
                className={`symbol-search-option${unknownCode === value ? ' selected' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  commit(unknownCode)
                }}
                title={unknownCode}
              >
                <span className="symbol-dot" aria-hidden="true" />
                <span>
                  {unknownCode} (поза бібліотекою)
                </span>
              </div>
            )}
            {matches.length > shown.length && (
              <div className="symbol-search-more">
                Показано {shown.length} з {matches.length} — уточніть пошук
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
