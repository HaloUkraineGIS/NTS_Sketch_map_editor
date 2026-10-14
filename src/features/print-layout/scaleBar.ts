import type { PrintFrame } from './grid'

/**
 * Масштабний штамп: «1:N» + чорно-біла сегментна лінійка в метрах (як scale_stamp.png).
 * Один SVG — і для превʼю (<img>), і для JPEG (drawImage): превʼю = друк.
 * Усі розміри в міліметрах аркуша.
 */

export const SCALE_BLOCK_MARGIN_MM = 4
const SEGMENTS = 4
const BAR_H_MM = 2
const SCALE_FS_MM = 3
const LABEL_FS_MM = 2
const BAR_Y_MM = 4.4
const LABEL_Y_MM = 8.8
const BLOCK_H_MM = 9.6
const UNIT_GAP_MM = 1
const UNIT_W_MM = 5

export type ScaleBarSpec = {
  scale: number
  scaleText: string
  totalMeters: number
  segMeters: number
  barLenMm: number
  blockWMm: number
  blockHMm: number
}

/** Округлення довжини до гарного 1/2/5·10ⁿ (метри). */
function niceMeters(raw: number): number {
  const exp = 10 ** Math.floor(Math.log10(raw))
  const mantissa = raw / exp
  const snap = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10
  return snap * exp
}

export function formatMeters(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

export function scaleBarSpec(scaleDenominator: number, targetMm = 20): ScaleBarSpec {
  const totalMeters = niceMeters((targetMm / 1000) * scaleDenominator)
  const barLenMm = (totalMeters / scaleDenominator) * 1000
  return {
    scale: scaleDenominator,
    scaleText: `1:${scaleDenominator.toLocaleString('uk-UA')}`,
    totalMeters,
    segMeters: totalMeters / SEGMENTS,
    barLenMm,
    blockWMm: barLenMm + UNIT_GAP_MM + UNIT_W_MM,
    blockHMm: BLOCK_H_MM,
  }
}

export function buildScaleBarSvg(spec: ScaleBarSpec): string {
  const segW = spec.barLenMm / SEGMENTS
  let segs = ''
  for (let i = 0; i < SEGMENTS; i++) {
    const fill = i % 2 === 0 ? '#000000' : '#ffffff'
    segs += `<rect x="${(i * segW).toFixed(2)}" y="${BAR_Y_MM}" width="${segW.toFixed(2)}" height="${BAR_H_MM}" fill="${fill}" stroke="#000000" stroke-width="0.25"/>`
  }
  let labels = ''
  for (let i = 0; i <= SEGMENTS; i++) {
    const pos = (i * segW).toFixed(2)
    const anchor = i === 0 ? 'start' : i === SEGMENTS ? 'end' : 'middle'
    const x = i === 0 ? '0' : i === SEGMENTS ? spec.barLenMm.toFixed(2) : pos
    labels += `<text x="${x}" y="${LABEL_Y_MM}" text-anchor="${anchor}" font-size="${LABEL_FS_MM}" fill="#000000">${formatMeters(i * spec.segMeters)}</text>`
  }
  const unitX = (spec.barLenMm + UNIT_GAP_MM).toFixed(2)
  const unitY = (BAR_Y_MM + BAR_H_MM / 2 + LABEL_FS_MM * 0.35).toFixed(2)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.blockWMm.toFixed(2)} ${spec.blockHMm}" width="${Math.round(spec.blockWMm * 10)}" height="${Math.round(spec.blockHMm * 10)}" font-family="Arial, Helvetica, sans-serif"><rect x="0" y="0" width="${spec.blockWMm.toFixed(2)}" height="${spec.blockHMm}" fill="#ffffff"/><text x="${(spec.barLenMm / 2).toFixed(2)}" y="3.2" text-anchor="middle" font-size="${SCALE_FS_MM}" font-weight="bold" fill="#000000">${spec.scaleText}</text>${segs}${labels}<text x="${unitX}" y="${unitY}" font-size="${LABEL_FS_MM}" fill="#000000">м</text></svg>`
}

export function scaleBarDataUrl(spec: ScaleBarSpec): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildScaleBarSvg(spec))}`
}

/** Дефолт — внизу по центру екстенту карти (кадру). */
export function defaultScaleBarPos(
  frame: PrintFrame,
  spec: ScaleBarSpec,
): { xMm: number; yMm: number } {
  return {
    xMm: (frame.widthMm - spec.blockWMm) / 2,
    yMm: frame.heightMm - spec.blockHMm - SCALE_BLOCK_MARGIN_MM,
  }
}
