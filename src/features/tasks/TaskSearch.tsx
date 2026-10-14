import { useEffect, useMemo, useRef, useState } from 'react'
import './task-search.css'

type Props = {
  codes: readonly unknown[]
  value: string
  disabled?: boolean
  onSelect: (code: string) => void
}

const MAX_OPTIONS = 80

/**
 * Швидкий пошук task_code замість нативного селекта (кодів ~2 тис.):
 * фільтр підрядком (спочатку збіги з початку), стрілки/Enter/Escape,
 * хрестик скидання. Вибір одразу застосовує фільтр карти через onSelect.
 */
export default function TaskSearch({ codes, value, disabled, onSelect }: Props) {
  const strings = useMemo(() => codes.map(String), [codes])
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  // Зовнішня зміна вибору — підтягнути текст поля (набір не чіпаємо:
  // під час друку value не змінюється, умова хибна).
  const [syncedValue, setSyncedValue] = useState(value)
  if (syncedValue !== value) {
    setSyncedValue(value)
    setText(value)
  }

  // Клік мимо комбобокса — закрити і повернути текст вибору.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setText(value)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, value])

  const query = text.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!query) return strings
    const starts: string[] = []
    const rest: string[] = []
    for (const code of strings) {
      const low = code.toLowerCase()
      if (!low.includes(query)) continue
      if (low.startsWith(query)) starts.push(code)
      else rest.push(code)
    }
    return [...starts, ...rest]
  }, [strings, query])

  const shown = matches.slice(0, MAX_OPTIONS)

  function commit(code: string) {
    setText(code)
    setOpen(false)
    setActive(0)
    if (code !== value) onSelect(code)
  }

  return (
    <div className="task-picker panel-task-picker" ref={boxRef}>
      <label htmlFor="task-code">АКТИВНЕ ЗАВДАННЯ</label>
      <div className="task-search-box">
        <input
          id="task-code"
          value={text}
          disabled={disabled}
          placeholder="Оберіть task_code…"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls="task-code-list"
          aria-autocomplete="list"
          onChange={(event) => {
            setText(event.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={(event) => {
            setOpen(true)
            event.target.select()
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActive((index) => Math.min(index + 1, Math.max(0, shown.length - 1)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              const exact = matches.find((code) => code.toLowerCase() === query)
              if (exact) {
                commit(exact)
              } else if (shown.length > 0) {
                commit(shown[Math.min(active, shown.length - 1)])
              }
              // Без збігів нічого не робимо — вибір не скидаємо мовчки.
            } else if (event.key === 'Escape') {
              setText(value)
              setOpen(false)
            }
          }}
        />
        {value && !disabled && (
          <button
            className="task-clear"
            title="Скинути завдання"
            aria-label="Скинути завдання"
            onMouseDown={(event) => {
              event.preventDefault()
              commit('')
            }}
          >
            ×
          </button>
        )}
        {open && !disabled && (
          <div className="task-options" id="task-code-list" role="listbox">
            {shown.length === 0 && <div className="task-empty">Нічого не знайдено</div>}
            {shown.map((code, index) => (
              <div
                key={code}
                role="option"
                aria-selected={code === value}
                className={`task-option${index === active ? ' active' : ''}${code === value ? ' selected' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  commit(code)
                }}
                onMouseEnter={() => setActive(index)}
              >
                {code}
              </div>
            ))}
            {matches.length > shown.length && (
              <div className="task-more">
                Показано {shown.length} з {matches.length} — уточніть пошук
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
