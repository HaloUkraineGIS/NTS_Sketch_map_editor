import { useEffect, useRef, useState } from 'react'
import { INSET_CUSTOM_SCALE_MAX, INSET_CUSTOM_SCALE_MIN, INSET_SCALES } from '../../config'

type Props = {
  label: string
  value: number
  ariaLabel: string
  hint?: string
  onChange: (scale: number) => void
  onError: (message: string) => void
}

const CUSTOM = 'custom'

/**
 * Масштаб інсет-карти: пресети + довільне значення, кратне 1000.
 * Той самий патерн, що в масштабу головної карти («Інший масштаб…» + поле).
 */
export default function InsetScaleSelect({ label, value, ariaLabel, hint, onChange, onError }: Props) {
  const isPreset = INSET_SCALES.includes(value)
  // Поле вводу — лише за явним вибором «Інший масштаб…», інакше тільки список.
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (customOpen) inputRef.current?.focus()
  }, [customOpen])

  function apply(raw: string) {
    const parsed = Number(raw.trim())
    if (
      !raw.trim() || !Number.isInteger(parsed) ||
      parsed < INSET_CUSTOM_SCALE_MIN || parsed > INSET_CUSTOM_SCALE_MAX ||
      parsed % 1000 !== 0
    ) {
      onError(
        `Масштаб інсета — ціле кратне 1000 від ${INSET_CUSTOM_SCALE_MIN} до ${INSET_CUSTOM_SCALE_MAX} (напр. 12000).`,
      )
      return
    }
    setDraft('')
    setCustomOpen(false)
    onChange(parsed)
  }

  return (
    <div className="control-group">
      <label>{label}</label>
      <select
        value={isPreset ? value : CUSTOM}
        onChange={(event) => {
          const raw = event.target.value
          if (raw === CUSTOM) {
            setCustomOpen(true)
            setDraft('')
          } else {
            setDraft('')
            setCustomOpen(false)
            onChange(Number(raw))
          }
        }}
        aria-label={ariaLabel}
      >
        {INSET_SCALES.map((item) => (
          <option key={item} value={item}>1:{item.toLocaleString('uk-UA')}</option>
        ))}
        <option value={CUSTOM}>
          {isPreset ? 'Інший масштаб…' : `Інший масштаб (1:${value.toLocaleString('uk-UA')})`}
        </option>
      </select>
      {(customOpen || !isPreset) && (
        <div className="scale-custom-row">
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply(draft)
              if (event.key === 'Escape') {
                setDraft('')
                // Як у головної карти: активний довільний масштаб лишає поле
                // відкритим, щоб одразу підібрати інше значення.
                if (isPreset) setCustomOpen(false)
              }
            }}
            placeholder="Кратне 1000, напр. 12000"
            inputMode="numeric"
            aria-label={`${ariaLabel}: власний масштаб`}
          />
          <button onClick={() => apply(draft)} title="Застосувати масштаб" aria-label="Застосувати масштаб">
            →
          </button>
        </div>
      )}
      {hint && <small>{hint}</small>}
    </div>
  )
}
