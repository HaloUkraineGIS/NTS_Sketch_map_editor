import WebMap from '@arcgis/core/WebMap.js'
import esriConfig from '@arcgis/core/config.js'
import Basemap from '@arcgis/core/Basemap.js'
import Graphic from '@arcgis/core/Graphic.js'
import type Layer from '@arcgis/core/layers/Layer.js'
import MapView from '@arcgis/core/views/MapView.js'
import Editor from '@arcgis/core/widgets/Editor.js'
import CreateFeaturesWorkflow from '@arcgis/core/widgets/Editor/CreateFeaturesWorkflow.js'
import FormTemplate from '@arcgis/core/form/FormTemplate.js'
import FieldElement from '@arcgis/core/form/elements/FieldElement.js'
import FeatureTemplate from '@arcgis/core/layers/support/FeatureTemplate.js'
import FeatureSnappingLayerSource from '@arcgis/core/views/interactive/snapping/FeatureSnappingLayerSource.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import { LAYER_URLS, PORTAL_URL, WEBMAP_ITEM_ID } from '../config'
import { DEFAULT_BASEMAP_ID, type BasemapId } from '../features/basemap/basemapOptions'
import { allInsetBasemapLayers, createInsetBasemapLayers, type InsetBasemapLayers } from '../features/basemap/basemap'
import type { EvidenceLibrary } from '../features/symbols/library'
import { surveyedLineTaskField, wireSurveyedLineTaskCode } from './surveyedLine'

export type LayerKey = keyof typeof LAYER_URLS
export type MapSession = {
  map: WebMap
  editView: MapView
  /** Друкована карта створюється ліниво при першому відкритті вкладки друку. */
  printView: MapView | null
  layers: Partial<Record<LayerKey, FeatureLayer>>
  /** Окремі шари підкладу для інсетів LM/BM (видимі тільки в них). */
  insetBasemapLayers: InsetBasemapLayers | null
  /** Існує лише у вкладці редагування; у друці — null (див. ensure/destroyEditor). */
  editor: Editor | null
  library: EvidenceLibrary | null
  symbolWarnings: string[]
  ensureEditor: (container: HTMLDivElement) => Editor
  destroyEditor: () => void
  /** Поточний task_code для автозапису в Surveyed line. */
  setSelectedTaskCode: (code: string) => void
  ensurePrintView: (container: HTMLDivElement) => Promise<MapView>
  destroy: () => void
}

function keyForUrl(url?: string | null): LayerKey | undefined {
  if (!url) return undefined
  return (Object.entries(LAYER_URLS).find(([, layerUrl]) =>
    url.split('?')[0].replace(/\/$/, '').toLowerCase() === layerUrl.toLowerCase(),
  )?.[0] as LayerKey | undefined)
}

function keyForLayer(layer: Layer): LayerKey | undefined {
  const byUrl = keyForUrl('url' in layer ? String(layer.url ?? '') : undefined)
  if (byUrl) return byUrl
  const title = (layer.title ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const aliases: Partial<Record<LayerKey, string[]>> = {
    task: ['task'],
    evidence: ['evidence', 'evidencepoint'],
    taskGeopoint: ['taskgeopoint'],
    taskPolygon: ['taskpolygon'],
    polygonGeopoint: ['polygongeopoint', 'taskpolygongeopoint'],
    topoPoint: ['topopoint', 'topopoints'],
    topoLines: ['topolines', 'topoline'],
    topoPolygons: ['topopolygons', 'topopolygon'],
    surveyedLine: ['surveyedline', 'surveyedlines'],
    imsmaPolygons: ['imsmapolygons', 'imsma_polygons', 'imsmapolygon'],
  }
  const exact = Object.entries(aliases).find(([, names]) => names?.includes(title))?.[0] as LayerKey | undefined
  if (exact) return exact
  // Автор WebMap міг перейменувати шар («Evidence points (live)» тощо).
  // Такі назви не ламають зіставлення; неточний збіг — лише останній шанс.
  if (title.includes('evidence')) return 'evidence'
  if (title.includes('surveyed')) return 'surveyedLine'
  return undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer)
        return value
      },
      (error) => {
        if (timer) clearTimeout(timer)
        throw error
      },
    ),
    timeout,
  ])
}

/**
 * Створює сесію з ОДНІЄЮ картою (редагування). Друкована карта підключається
 * пізніше через ensurePrintView — коли вкладка друку видима. Так старт не залежить
 * від ініціалізації прихованого в’ю і важить удвічі менше.
 */
export async function createMapSession(
  editContainer: HTMLDivElement,
  onStep?: (step: string) => void,
  onAutoCreateError?: (message: string) => void,
): Promise<MapSession> {
  let selectedTaskCode = ''
  esriConfig.portalUrl = PORTAL_URL
  onStep?.('Відкриття WebMap…')
  const map = new WebMap({ portalItem: { id: WEBMAP_ITEM_ID } })
  await withTimeout(map.load(), 60000, 'WebMap не завантажилась за 60 с. Перевірте сесію Portal і мережу.')

  // Детермінований стартовий підклад редагування (замість авторського з WebMap);
  // вибір користувача — селектором у вкладці редагування.
  try {
    const initial = Basemap.fromId(DEFAULT_BASEMAP_ID)
    if (initial) map.basemap = initial
  } catch {
    /* лишається підклад WebMap */
  }

  const layers: Partial<Record<LayerKey, FeatureLayer>> = {}
  map.allLayers.forEach((layer) => {
    if (layer.type === 'feature') {
      const featureLayer = layer as FeatureLayer
      const key = keyForLayer(layer)
      if (!key) return
      layers[key] = featureLayer
      featureLayer.outFields = ['*']
    }
  })

  onStep?.('Створення карти редагування…')
  const editView = new MapView({
    map,
    container: editContainer,
    popupEnabled: true,
    constraints: { snapToZoom: false },
  })
  await withTimeout(editView.when(), 60000, 'Карта редагування не створилась за 60 с.')

  // Окремі шари підкладу для інсетів (вибір підкладу інсетів не чіпає редагування):
  // базові — вниз стеку, референсні (підписи) — поверх даних.
  // Видимі тільки в інсетах (політика в syncBasemapVisibility); тут ховаємо в редагуванні.
  onStep?.('Підготовка підкладів для інсетів…')
  let insetBasemapLayers: InsetBasemapLayers | null
  let insetTopoWarning: string | null = null
  try {
    const created = createInsetBasemapLayers()
    const ids = Object.keys(created) as BasemapId[]
    for (const id of ids) {
      for (const layer of created[id].base) map.add(layer, 0)
    }
    for (const id of ids) {
      for (const layer of created[id].reference) map.add(layer)
    }
    insetBasemapLayers = created
    await Promise.all(
      allInsetBasemapLayers(created).map(async (layer) => {
        try {
          const layerView = await editView.whenLayerView(layer)
          layerView.visible = false
        } catch {
          /* LayerView ще нема — політика сховає пізніше */
        }
      }),
    )
  } catch (error) {
    insetBasemapLayers = null
    insetTopoWarning =
      `Підклади для інсетів не створились: ${error instanceof Error ? error.message : 'невідома помилка'} — карти LM/BM будуть без підкладу.`
  }

  // Схема шарів (fields) потрібна до бібліотеки: інакше перевірка symbol_code
  // спрацьовує по незавантажених полях і лишає застарілі варнінги.
  onStep?.('Завантаження схеми шарів…')
  await Promise.all(
    Object.values(layers)
      .filter((layer): layer is FeatureLayer => !!layer)
      .map((layer) => layer.load().catch(() => null)),
  )

  // Бібліотека — ДО створення Editor: віджет читає templates шарів один раз при старті.
  onStep?.('Завантаження бібліотеки знаків…')
  let library: EvidenceLibrary | null = null
  const symbolWarnings: string[] = []
  if (insetTopoWarning) symbolWarnings.push(insetTopoWarning)
  if (layers.surveyedLine) {
    // Якщо сервіс дозволяє редагування, не даємо авторському WebMap-прапорцю
    // editingEnabled=false приховати шар від Editor.
    if (layers.surveyedLine.capabilities?.operations.supportsEditing) {
      layers.surveyedLine.editingEnabled = true
    }
    if (surveyedLineTaskField(layers.surveyedLine)) {
      wireSurveyedLineTaskCode(layers.surveyedLine, () => selectedTaskCode)
    } else {
      symbolWarnings.push(
        'У шарі Surveyed line не знайдено поле task_code — автозапис коду та фільтр завдання для цього шару вимкнено.',
      )
    }
    // Editor показує в панелі створення лише шари з templates. Якщо сервіс
    // не має авторських шаблонів, даємо один стандартний, щоб шар можна було редагувати.
    if (!layers.surveyedLine.templates?.length) {
      layers.surveyedLine.templates = [new FeatureTemplate({
        name: layers.surveyedLine.title || 'Surveyed line',
        description: 'Лінія інструментальної зйомки',
        drawingTool: 'line',
      })]
    }
  }
  try {
    const { loadEvidenceLibrary, applyLibraryRenderers, applyLayerTemplates } =
      await import('../features/symbols/library')
    library = await loadEvidenceLibrary()
    // Стартовий контекст — редагування: екранні тайли (ground=false).
    symbolWarnings.push(
      ...(await applyLibraryRenderers(layers, library)),
      ...(await applyLayerTemplates(layers, library)),
    )
  } catch (error) {
    symbolWarnings.push(
      `Бібліотека знаків не завантажилась: ${error instanceof Error ? error.message : 'невідома помилка'}.`,
    )
  }

  const topoKeys: LayerKey[] = ['topoPoint', 'topoLines', 'topoPolygons']
  // Поля, які застосунок заповнює сам і не показує у формі Editor.
  const editorHiddenFields: Partial<Record<LayerKey, string[]>> = {
    topoPoint: ['symbol_code'],
    topoLines: ['symbol_code'],
    topoPolygons: ['symbol_code'],
    surveyedLine: ['task_code'],
  }
  // Порядок у панелі Editor: Surveyed line, полігони, лінії, точки. Решта шарів
  // (переважно read-only) іде після них у порядку WebMap.
  const editorEditableKeys: LayerKey[] = ['surveyedLine', 'topoPolygons', 'topoLines', 'topoPoint']

  // Форма редагованого шару: службові поля приховані, бо їх проставляє
  // застосунок. Якщо інших редагованих полів немає, лишаємо в формі тільки
  // приховане поле з visibilityExpression=false: порожній formTemplate Editor
  // ігнорує й показує всі поля, включно зі службовими.
  const buildEditorFormTemplate = (
    layer: FeatureLayer,
    key: LayerKey,
    hiddenNames: string[],
  ): FormTemplate | null => {
    try {
      const hiddenFields = hiddenNames
        .map((name) => layer.fields?.find((field) => field.name.toLowerCase() === name.toLowerCase())?.name)
        .filter((name): name is string => !!name)
      const hidden = new Set(hiddenFields)
      const elements: FieldElement[] = []
      for (const field of layer.fields ?? []) {
        if (field.name === layer.objectIdField) continue
        if (layer.globalIdField && field.name === layer.globalIdField) continue
        if (field.editable === false) continue
        if (hidden.has(field.name)) continue
        elements.push(new FieldElement({ fieldName: field.name, label: field.alias || field.name }))
      }
      if (!elements.length && hiddenFields.length) {
        const hiddenField = hiddenFields[0]
        const field = layer.fields?.find((candidate) => candidate.name === hiddenField)
        elements.push(new FieldElement({
          fieldName: hiddenField,
          label: field?.alias || hiddenField,
          visibilityExpression: 'false',
        }))
      }
      if (!elements.length) return null
      return new FormTemplate({ title: layer.title || 'Обʼєкт', elements })
    } catch (error) {
      symbolWarnings.push(
        `Не вдалося задати форму для ${key}: ${error instanceof Error ? error.message : 'невідома помилка'}.`,
      )
      return null
    }
  }

  // Evidence навмисно ВИМКНЕНО в Editor: усі правки лише через таблицю атрибутів
  // (таблиця пише applyEdits напряму і від Editor не залежить).
  // ТИМЧАСОВО для порівняння: створення повернено в Editor, власний
  // TemplatePicker приховано в App. Якщо TemplatePicker виграє — повернути
  // addEnabled: false і показати TemplatePicker назад.
  const buildEditorLayerInfos = () => {
    const ordered: [LayerKey, FeatureLayer][] = []
    for (const key of editorEditableKeys) {
      const layer = layers[key]
      if (layer) ordered.push([key, layer])
    }
    for (const [key, layer] of Object.entries(layers)) {
      const layerKey = key as LayerKey
      if (!layer || editorEditableKeys.includes(layerKey)) continue
      ordered.push([layerKey, layer])
    }
    return ordered.flatMap(([layerKey, layer]) => {
      if (!editorEditableKeys.includes(layerKey)) return [{ layer, enabled: false }]
      // Editor 5.x бере форму з layerInfo, а не з layer.formTemplate.
      // Дублюємо на шарі — для FeatureForm/попапів та інших віджетів.
      const formTemplate = buildEditorFormTemplate(
        layer,
        layerKey,
        editorHiddenFields[layerKey] ?? [],
      )
      if (formTemplate) layer.formTemplate = formTemplate
      return [{
        layer,
        enabled: true,
        addEnabled: true,
        updateEnabled: true,
        deleteEnabled: true,
        geometryUpdatesEnabled: true,
        attributeUpdatesEnabled: true,
        attachmentsOnCreateEnabled: false,
        attachmentsOnUpdateEnabled: false,
        ...(formTemplate ? { formTemplate } : {}),
      }]
    })
  }

  const applyEditorFormTemplates = () => {
    for (const key of editorEditableKeys) {
      const layer = layers[key]
      if (!layer) continue
      const formTemplate = buildEditorFormTemplate(
        layer,
        key,
        editorHiddenFields[key] ?? [],
      )
      if (formTemplate) layer.formTemplate = formTemplate
    }
  }
  applyEditorFormTemplates()

  // Автозавершення створення: після домалювання обʼєкта пишемо його одразу,
  // без кліку «Створити». Тільки потік створення (оновлення має власне збереження).
  const wireAutoCreate = (editor: Editor) => {
    (editor as unknown as { on(type: string, listener: (event: unknown) => void): unknown }).on(
      'sketch-create',
      (event: unknown) => {
        const detail = (event as unknown as {
          detail?: { state?: unknown; graphic?: Graphic | null }
        }).detail
        if (!detail || detail.state !== 'complete' || !detail.graphic) return
        let workflow: unknown
        try {
          workflow = editor.viewModel?.activeWorkflow
        } catch {
          return
        }
        if (!(workflow instanceof CreateFeaturesWorkflow)) return
        const graphic = detail.graphic
        const target = graphic.layer as FeatureLayer | null
        if (!target || typeof target.applyEdits !== 'function' || !graphic.geometry) return
        // Surveyed line зберігається штатним workflow Editor: користувач має
        // заповнити інші атрибути, а task_code допише обгортка applyEdits.
        const targetKey = keyForLayer(target)
        if (!targetKey || !topoKeys.includes(targetKey)) return
        const attributes: Record<string, unknown> = {
          ...((graphic.attributes ?? {}) as Record<string, unknown>),
        }
        if (target.objectIdField) delete attributes[target.objectIdField]
        if (target.globalIdField) delete attributes[target.globalIdField]
        // Скидаємо віджет першим: користувач не встигне натиснути «Створити» двічі.
        try {
          editor.cancelWorkflow()
        } catch {
          /* ignore */
        }
        const write = new Graphic({ geometry: graphic.geometry, attributes })
        target.applyEdits({ addFeatures: [write] }).then(
          () => undefined,
          (error: unknown) => {
            onAutoCreateError?.(
              `Не вдалося створити обʼєкт: ${error instanceof Error ? error.message : 'невідома помилка'}.`,
            )
          },
        )
      },
    )
  }

  // Снапінг: явно вмикаємо ВСІ шари карти як джерела (за дефолтом частина
  // могла бути вимкнена) + власний скетч. Як у TemplatePicker.
  const snappingSources = map.allLayers
    .toArray()
    .filter((layer): layer is FeatureLayer => layer.type === 'feature')
    .map((layer) => new FeatureSnappingLayerSource({ layer, enabled: true }))

  const makeEditor = () => {
    const editor = new Editor({
      view: editView,
      layerInfos: buildEditorLayerInfos(),
      snappingOptions: {
        enabled: true,
        featureEnabled: true,
        selfEnabled: true,
        featureSources: snappingSources,
      },
    })
    wireAutoCreate(editor)
    return editor
  }
  // Editor живе ТІЛЬКИ у вкладці редагування: при переході в друк знищується
  // (destroyEditor), при поверненні створюється заново (ensureEditor).
  // Переставляння container між вкладками лишало DOM віджета в чужій панелі.
  const session: MapSession = {
    map,
    editView,
    printView: null,
    layers,
    insetBasemapLayers,
    editor: makeEditor(),
    library,
    symbolWarnings,
    ensureEditor: (container: HTMLDivElement) => {
      if (session.editor) {
        session.editor.container = container
        return session.editor
      }
      const editor = makeEditor()
      editor.container = container
      session.editor = editor
      return editor
    },
    destroyEditor: () => {
      try {
        session.editor?.destroy()
      } catch {
        /* already destroyed */
      }
      session.editor = null
    },
    setSelectedTaskCode: (code: string) => {
      selectedTaskCode = String(code ?? '').trim()
    },
    ensurePrintView: async (container: HTMLDivElement) => {
      if (session.printView) return session.printView
      const printView = new MapView({
        map,
        container,
        popupEnabled: false,
        // Макет друку — чистий аркуш: без віджетів навігації Esri і без зума колесом,
        // масштаб лише зі списку (страховка — ensureScale в App).
        constraints: { snapToZoom: false, rotationEnabled: false },
      })
      printView.navigation.actionMap.mouseWheel = 'none'
      printView.ui.components = []
      await withTimeout(printView.when(), 60000, 'Друкована карта не створилась за 60 с.')
      session.printView = printView
      return printView
    },
    destroy: () => {
      try {
        session.editor?.destroy()
      } catch {
        /* already destroyed */
      }
      session.editor = null
      try {
        if (session.printView) {
          session.printView.map = null
          session.printView.destroy()
          session.printView = null
        }
      } catch {
        /* already destroyed */
      }
      try {
        editView.map = null
        editView.destroy()
      } catch {
        /* already destroyed */
      }
      try {
        map.destroy()
      } catch {
        /* already destroyed */
      }
    },
  }
  return session
}
