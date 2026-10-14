#!/usr/bin/env node
// Інструменти бібліотеки умовних знаків.
//   node scripts/symbols.mjs check
//     Перевіряє public/symbols/library.json: унікальність кодів, відомі шари,
//     наявність SVG-файлів, коректність fill/stroke. Використовується в prebuild.
//   node scripts/symbols.mjs import-dir <папка> --geometry=point --layers=topoPoint [--field=symbol_code] [--prefix=TOPO_] [--color=#555555]
//     Масове додавання: кожен *.svg у папці стає записом (code з імені файла).
//     Існуючі коди не чіпає. Назви (name) потім відредагуйте вручну.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libraryPath = join(root, 'public', 'symbols', 'library.json')
const publicDir = join(root, 'public')

const LAYER_KEYS = new Set([
  'task', 'evidence', 'taskGeopoint', 'taskPolygon', 'polygonGeopoint',
  'topoPoint', 'topoLines', 'topoPolygons', 'imsmaPolygons',
])
const EDITABLE_KEYS = new Set(['evidence', 'topoPoint', 'topoLines', 'topoPolygons'])
const GEOMETRIES = new Set(['point', 'line', 'polygon'])

function loadLibrary() {
  const raw = readFileSync(libraryPath, 'utf8')
  return JSON.parse(raw)
}

function check() {
  const errors = []
  const warnings = []
  let library
  try {
    library = loadLibrary()
  } catch (error) {
    console.error(`FAIL: не читається library.json: ${error.message}`)
    process.exit(1)
  }
  if (!Array.isArray(library.symbols)) {
    console.error('FAIL: symbols має бути масивом.')
    process.exit(1)
  }
  const seen = new Map()
  library.symbols.forEach((symbol, index) => {
    const where = `symbols[${index}]`
    if (!symbol || typeof symbol.code !== 'string' || !symbol.code) {
      errors.push(`${where}: порожній code.`)
      return
    }
    if (seen.has(symbol.code)) {
      errors.push(`${where}: дубль коду ${symbol.code} (вже є в symbols[${seen.get(symbol.code)}]).`)
    } else {
      seen.set(symbol.code, index)
    }
    if (typeof symbol.name !== 'string' || !symbol.name) {
      errors.push(`${symbol.code}: порожній name.`)
    }
    const geometry = symbol.geometry ?? 'point'
    if (!GEOMETRIES.has(geometry)) {
      errors.push(`${symbol.code}: невідома geometry ${geometry}.`)
    }
    if (!Array.isArray(symbol.layers) || symbol.layers.length === 0) {
      errors.push(`${symbol.code}: порожній layers — знак ніде не зʼявиться.`)
    } else {
      for (const key of symbol.layers) {
        if (!LAYER_KEYS.has(key)) errors.push(`${symbol.code}: невідомий шар ${key}.`)
        else if (!EDITABLE_KEYS.has(key)) {
          warnings.push(`${symbol.code}: шар ${key} read-only — знак відмалюється, але створити/правити буде ніде.`)
        }
      }
    }
    if (geometry === 'point' && !symbol.hidden) {
      if (typeof symbol.svg !== 'string' || !symbol.svg) {
        errors.push(`${symbol.code}: точка без svg.`)
      } else if (!existsSync(join(publicDir, symbol.svg))) {
        errors.push(`${symbol.code}: файл не знайдено: public/${symbol.svg}.`)
      }
    }
    if (geometry === 'line' && typeof symbol.svg === 'string' && symbol.svg) {
      if (!existsSync(join(publicDir, symbol.svg))) {
        errors.push(`${symbol.code}: файл не знайдено: public/${symbol.svg}.`)
      }
    }
    if (symbol.pattern) {
      const strokes = symbol.pattern.strokes ?? []
      const markers = symbol.pattern.markers ?? []
      if (!Array.isArray(strokes) || !Array.isArray(markers)) {
        errors.push(`${symbol.code}: pattern.strokes/markers мають бути масивами.`)
      } else {
        if (strokes.length === 0 && markers.length === 0) {
          errors.push(`${symbol.code}: порожній pattern.`)
        }
        strokes.forEach((stroke, index) => {
          if (!(stroke.width > 0)) errors.push(`${symbol.code}: strokes[${index}].width має бути > 0.`)
          if (stroke.dash !== undefined && (!Array.isArray(stroke.dash) || !stroke.dash.every((v) => v > 0))) {
            errors.push(`${symbol.code}: strokes[${index}].dash — масив додатних чисел.`)
          }
        })
        const shapes = new Set(['tick', 'tooth-up', 'tooth-down', 'check-up', 'check-down', 'chevron', 'dot'])
        markers.forEach((marker, index) => {
          if (!shapes.has(marker.shape)) errors.push(`${symbol.code}: markers[${index}].shape невідомий.`)
          if (!(marker.size > 0)) errors.push(`${symbol.code}: markers[${index}].size має бути > 0.`)
          if (marker.placement !== undefined && marker.placement !== 'along' && marker.placement !== 'vertices') {
            errors.push(`${symbol.code}: markers[${index}].placement має бути along або vertices.`)
          }
          if (marker.placement !== 'vertices' && !(marker.interval > 0)) {
            errors.push(`${symbol.code}: markers[${index}].interval має бути > 0.`)
          }
        })
        const paired = symbol.pattern.pairedArrows
        if (paired !== undefined) {
          if (typeof paired !== 'object' || paired === null) {
            errors.push(`${symbol.code}: pairedArrows має бути обʼєктом.`)
          } else {
            for (const key of ['size', 'distance', 'gap']) {
              if (paired[key] !== undefined && !(paired[key] > 0)) {
                errors.push(`${symbol.code}: pairedArrows.${key} має бути > 0.`)
              }
            }
          }
        }
      }
    }
    if (geometry === 'line' && !symbol.stroke) {
      warnings.push(`${symbol.code}: лінія без stroke — буде сіра за замовчуванням.`)
    }
    if (geometry === 'polygon' && symbol.fill) {
      if (symbol.fill.markerSvg) {
        if (typeof symbol.fill.markerSvg !== 'string' || !existsSync(join(publicDir, symbol.fill.markerSvg))) {
          errors.push(`${symbol.code}: файл маркера не знайдено: public/${symbol.fill?.markerSvg}.`)
        }
        if (!(symbol.fill.spacingMm > 0)) errors.push(`${symbol.code}: fill.spacingMm має бути > 0.`)
      } else if (symbol.fill.color) {
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(symbol.fill.color)) {
          errors.push(`${symbol.code}: fill.color має бути hex (#rgb/#rrggbb).`)
        }
        if (symbol.fill.opacity !== undefined && !(symbol.fill.opacity >= 0 && symbol.fill.opacity <= 1)) {
          errors.push(`${symbol.code}: fill.opacity має бути 0–1.`)
        }
      }
      if (symbol.fill.layout !== undefined && symbol.fill.layout !== 'checker' && symbol.fill.layout !== 'grid' && symbol.fill.layout !== 'scatter') {
        errors.push(`${symbol.code}: fill.layout має бути checker, grid або scatter.`)
      }
      if (symbol.fill.scatter !== undefined) {
        if (!Array.isArray(symbol.fill.scatter) || symbol.fill.scatter.length === 0) {
          errors.push(`${symbol.code}: fill.scatter має бути непорожнім масивом.`)
        } else {
          symbol.fill.scatter.forEach((item, index) => {
            for (const key of ['dx', 'dy', 'rotate', 'scale']) {
              if (item[key] !== undefined && typeof item[key] !== 'number') {
                errors.push(`${symbol.code}: fill.scatter[${index}].${key} має бути числом.`)
              }
            }
          })
        }
      }
    }
    if (symbol.outline?.style !== undefined && !['solid', 'dash', 'dot', 'dash-dot'].includes(symbol.outline.style)) {
      errors.push(`${symbol.code}: outline.style має бути solid/dash/dot/dash-dot.`)
    }
  })
  for (const warning of warnings) console.log(`WARN: ${warning}`)
  if (errors.length) {
    for (const error of errors) console.error(`FAIL: ${error}`)
    console.error(`\n${errors.length} помилок, ${warnings.length} попереджень.`)
    process.exit(1)
  }
  console.log(`OK: ${library.symbols.length} знаків, ${warnings.length} попереджень.`)
}

function parseFlags(args) {
  const flags = {}
  const rest = []
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      if (equals === -1) flags[arg.slice(2)] = true
      else flags[arg.slice(2, equals)] = arg.slice(equals + 1)
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function importDir(dirArg, options) {
  const geometry = options.geometry ?? 'point'
  if (!GEOMETRIES.has(geometry)) {
    console.error(`FAIL: --geometry має бути ${[...GEOMETRIES].join('/')}.`)
    process.exit(1)
  }
  const layers = String(options.layers ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!layers.length || layers.some((key) => !LAYER_KEYS.has(key))) {
    console.error(`FAIL: --layers: кома-список з ${[...LAYER_KEYS].join(', ')}.`)
    process.exit(1)
  }
  const prefix = options.prefix ?? ''
  const dir = resolve(root, dirArg)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`FAIL: не папка: ${dirArg}.`)
    process.exit(1)
  }
  const library = loadLibrary()
  if (!Array.isArray(library.symbols)) {
    console.error('FAIL: symbols має бути масивом.')
    process.exit(1)
  }
  const existing = new Set(library.symbols.map((s) => s?.code))
  let added = 0
  let skipped = 0
  for (const file of readdirSync(dir).sort()) {
    if (extname(file).toLowerCase() !== '.svg') continue
    const base = basename(file, '.svg')
    const code = `${prefix}${base.toUpperCase().replace(/[^A-Z0-9]+/gi, '_').replace(/^_|_$/g, '')}`
    if (!code || existing.has(code)) {
      skipped += 1
      continue
    }
    const absolute = join(dir, file)
    const rel = absolute.startsWith(publicDir)
      ? absolute.slice(publicDir.length + 1).replace(/\\/g, '/')
      : null
    if (!rel) {
      console.error(`FAIL: ${file} поза public/ — імпорт лише з-під public/.`)
      process.exit(1)
    }
    const entry = { code, name: base, geometry, layers, field: options.field ?? 'symbol_code' }
    if (geometry === 'point') entry.svg = rel
    if (geometry === 'line') entry.stroke = { color: options.color ?? '#555555', width: 2, style: 'solid' }
    if (geometry === 'polygon') {
      entry.color = options.color ?? '#555555'
      entry.outline = { color: options.color ?? '#555555', width: 2 }
    }
    library.symbols.push(entry)
    existing.add(code)
    added += 1
  }
  writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`)
  console.log(`OK: додано ${added}, пропущено (дублі) ${skipped}. Назви name відредагуйте вручну.`)
}

const [command, ...args] = process.argv.slice(2)
if (command === 'check') {
  check()
} else if (command === 'import-dir') {
  const { flags, rest } = parseFlags(args)
  if (!rest[0]) {
    console.error('FAIL: вкажіть папку: import-dir <папка> --geometry=point --layers=topoPoint')
    process.exit(1)
  }
  importDir(rest[0], flags)
} else {
  console.error('Використання: node scripts/symbols.mjs check | import-dir <папка> --geometry=point --layers=topoPoint')
  process.exit(1)
}
