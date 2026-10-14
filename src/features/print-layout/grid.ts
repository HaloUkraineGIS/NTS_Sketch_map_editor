export type PrintFrame = {
  leftMm: number
  topMm: number
  widthMm: number
  heightMm: number
}

export type UTMCenter = { x: number; y: number }

/**
 * Якір підписів сітки: зазор рамка→текст 1.5мм + пів шрифту 2.2мм.
 * Той самий відступ закладається в рамку кадру (App frameFor).
 */
export const GRID_LABEL_ANCHOR_MM = 1.5 + 2.2 / 2

export function drawUtmGrid(
  context: CanvasRenderingContext2D,
  frame: PrintFrame,
  center: UTMCenter,
  scaleDenominator: number,
  dpi = 300,
  declutterLabels = false,
) {
  const pxPerMm = dpi / 25.4
  const left = frame.leftMm * pxPerMm
  const top = frame.topMm * pxPerMm
  const width = frame.widthMm * pxPerMm
  const height = frame.heightMm * pxPerMm
  const stepMeters = scaleDenominator / 1000
  const xmin = center.x - frame.widthMm * scaleDenominator / 2000
  const xmax = center.x + frame.widthMm * scaleDenominator / 2000
  const ymin = center.y - frame.heightMm * scaleDenominator / 2000
  const ymax = center.y + frame.heightMm * scaleDenominator / 2000

  context.save()
  context.beginPath()
  context.rect(left, top, width, height)
  context.clip()

  const firstX = Math.ceil(xmin / stepMeters) * stepMeters
  const firstY = Math.ceil(ymin / stepMeters) * stepMeters
  const lastXIndex = Math.floor((xmax - firstX) / stepMeters + 1e-8)
  const lastYIndex = Math.floor((ymax - firstY) / stepMeters + 1e-8)
  const maxGridLines = 1800
  const xStride = Math.max(1, Math.ceil((lastXIndex + 1) / maxGridLines))
  const yStride = Math.max(1, Math.ceil((lastYIndex + 1) / maxGridLines))

  for (let index = 0; index <= lastXIndex; index += xStride) {
    const coordinate = firstX + index * stepMeters
    const x = left + ((coordinate - xmin) / (xmax - xmin)) * width
    const major = Math.abs(coordinate / (stepMeters * 10) - Math.round(coordinate / (stepMeters * 10))) < 1e-6
    context.beginPath()
    context.strokeStyle = major ? '#111827' : 'rgba(71, 85, 105, 0.43)'
    context.lineWidth = major ? 1 : 0.45
    context.moveTo(x, top)
    context.lineTo(x, top + height)
    context.stroke()
  }

  for (let index = 0; index <= lastYIndex; index += yStride) {
    const coordinate = firstY + index * stepMeters
    const y = top + height - ((coordinate - ymin) / (ymax - ymin)) * height
    const major = Math.abs(coordinate / (stepMeters * 10) - Math.round(coordinate / (stepMeters * 10))) < 1e-6
    context.beginPath()
    context.strokeStyle = major ? '#111827' : 'rgba(71, 85, 105, 0.43)'
    context.lineWidth = major ? 1 : 0.45
    context.moveTo(left, y)
    context.lineTo(left + width, y)
    context.stroke()
  }
  context.restore()

  // Підписи лише зовні: Easting знизу, Northing зліва вертикально, без букв — як на паперовому аркуші.
  context.save()
  context.fillStyle = '#344054'
  context.font = `${Math.max(7, 2.2 * pxPerMm)}px Inter, Arial, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  // У превʼю місця мало: підписи, що накладаються, пропускаємо, крок сітки не чіпаємо.
  // Поріг — реальна ширина тексту + запас (фіксовані 44px або ховали потрібне, або лишали кашу).
  const declutter = declutterLabels
  let lastLabelX = Number.NEGATIVE_INFINITY
  const majorStepMeters = stepMeters * 10 * xStride
  const firstMajorX = Math.ceil(xmin / majorStepMeters) * majorStepMeters
  for (let coordinate = firstMajorX; coordinate <= xmax; coordinate += majorStepMeters) {
    const x = left + ((coordinate - xmin) / (xmax - xmin)) * width
    if (declutter) {
      const textWidth = context.measureText(`${Math.round(coordinate)}`).width
      if (Math.abs(x - lastLabelX) < textWidth + 8) continue
    }
    lastLabelX = x
    context.fillText(`${Math.round(coordinate)}`, x, top + height + GRID_LABEL_ANCHOR_MM * pxPerMm)
  }
  context.textAlign = 'right'
  let lastLabelY = Number.NEGATIVE_INFINITY
  const majorStepNorthing = stepMeters * 10 * yStride
  const firstMajorY = Math.ceil(ymin / majorStepNorthing) * majorStepNorthing
  // Ліві підписи — вертикально (читаються знизу вгору), впритул до рамки.
  const leftLabelX = left - GRID_LABEL_ANCHOR_MM * pxPerMm
  for (let coordinate = firstMajorY; coordinate <= ymax; coordinate += majorStepNorthing) {
    const y = top + height - ((coordinate - ymin) / (ymax - ymin)) * height
    const text = `${Math.round(coordinate)}`
    if (declutter) {
      const textHeight = context.measureText(text).width
      if (Math.abs(y - lastLabelY) < textHeight + 6) continue
    }
    lastLabelY = y
    context.save()
    context.translate(leftLabelX, y)
    context.rotate(-Math.PI / 2)
    context.textAlign = 'center'
    context.fillText(text, 0, 0)
    context.restore()
  }
  context.restore()
  context.save()
  context.strokeStyle = '#263444'
  context.lineWidth = 1.2
  context.strokeRect(left, top, width, height)
  context.restore()
}

export function a4Dimensions(orientation: 'portrait' | 'landscape') {
  return orientation === 'portrait'
    ? { widthMm: 210, heightMm: 297 }
    : { widthMm: 297, heightMm: 210 }
}
