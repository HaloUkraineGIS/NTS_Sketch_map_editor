import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type { Edits } from '@arcgis/core/editing/types.js'

export const SURVEYED_LINE_TASK_FIELD = 'task_code'

/** Реальне ім'я поля task_code у шарі (регістр може відрізнятися від сервісу). */
export function surveyedLineTaskField(layer: FeatureLayer): string | undefined {
  return layer.fields?.find(
    (field) => field.name.toLowerCase() === SURVEYED_LINE_TASK_FIELD,
  )?.name
}

function stampFeatures(
  features: Edits['addFeatures'] | Edits['updateFeatures'],
  field: string,
  taskCode: string,
): void {
  if (!features) return
  const list = Array.isArray(features) ? features : features.toArray()
  for (const graphic of list) {
    graphic.attributes = { ...(graphic.attributes ?? {}), [field]: taskCode }
  }
}

/**
 * Автозапис вибраного task_code у Surveyed line.
 *
 * Обгортка layer.applyEdits спрацьовує ДО відправки на сервер, тому код
 * потрапляє і в створення, і в оновлення (включно з геометрією), і не
 * залежить від того, який workflow Editor використав для збереження.
 * Порожній вибір завдання нічого не перезаписує.
 */
export function wireSurveyedLineTaskCode(
  layer: FeatureLayer,
  getTaskCode: () => string,
): void {
  if (!surveyedLineTaskField(layer)) return
  const originalApplyEdits = layer.applyEdits.bind(layer)
  layer.applyEdits = (edits, options) => {
    const taskCode = String(getTaskCode() ?? '').trim()
    const field = surveyedLineTaskField(layer)
    if (taskCode && field) {
      stampFeatures(edits.addFeatures, field, taskCode)
      stampFeatures(edits.updateFeatures, field, taskCode)
    }
    return originalApplyEdits(edits, options)
  }
}
