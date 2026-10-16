import type { EvidenceLibrary } from '../symbols/library'

export const NO_CODE_LABEL = '— без коду —'

/** Що показувати в комірці/полі для коду: назву знака, а не код. */
export function symbolDisplayName(library: EvidenceLibrary | null, code: string): string {
  if (!code) return '—'
  const found = library?.symbols.find((s) => s.code === code)
  return found ? found.name : `${code} (поза бібліотекою)`
}
