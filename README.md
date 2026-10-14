# Sketch map

Вебклієнт для роботи з організаційною ArcGIS WebMap: фільтрація завдань, редагування дозволених Feature Services та підготовка A4 JPEG із фіксованим масштабом і UTM-сіткою.

Докладні вимоги, архітектура, етапи й критерії приймання: [PROJECT_SPEC.md](PROJECT_SPEC.md). Історія реалізованих змін і наступних перевірок: [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

## Запуск локально

```sh
npm ci
npm run dev
```

Vite використовує `http://localhost:5173/`. У налаштуваннях Portal Application має бути зареєстрований redirect URI `http://localhost:5173` (він уже заданий для цього застосунку). Вхід реалізовано через OAuth PKCE та IdentityManager ArcGIS Maps SDK; Client ID є публічним і не є секретом.

## Публікація в GitHub Pages

1. Створіть GitHub repository і push-ніть гілку `main`.
2. У Portal Application додайте точний production URI GitHub Pages, наприклад `https://<owner>.github.io/<repository>/`.
3. У GitHub repository відкрийте **Settings → Pages** та оберіть **GitHub Actions** як source.
4. Workflow `.github/workflows/deploy.yml` збирає Vite із правильним base path і публікує `dist`.

Захищені WebMap та Feature Services повинні залишатися доступними лише належним користувачам/групам у Portal. Не додавайте client secret у код, GitHub Secrets або Pages: браузерний застосунок використовує OAuth PKCE без секрету.

## Поточні компоненти

- Portal: `https://gis.htgoims.org/portal`
- WebMap item: `346b8032e4ae40e582249ba5f9dfe872`
- Редаговані шари Topo: створення/оновлення/видалення через ArcGIS Editor (відповідно до capabilities сервісу).
- Evidence: Editor обмежений оновленням атрибутів; клієнтський інтерфейс не є security boundary — серверні permissions також мають забороняти непотрібні операції.
- Вкладка друку: A4 portrait/landscape, масштаби, вибір UTM EPSG:32635/32636/32637, координатна сітка, JPEG 300 dpi.

## Конфігурація символів

Бібліотека — `public/symbols/library.json` (схема з автодоповненням: `public/symbols/library.schema.json`).
Один запис = один знак: `code` (значення `symbol_code`), `name`, `geometry` (point/line/polygon),
`layers` (ключі шарів, де знак дозволений), плюс `svg` / `stroke` / `outline+fill`.
Шаблони створення, renderer, випадайка таблиці evidence і легенда будуються з цього файла
автоматично — код правити не треба. SVG: 48×48, прозорий фон, у `public/symbols/`.

```sh
npm run symbols:check                                     # перевірка (ходить і в prebuild)
npm run symbols:import -- public/symbols/_new --geometry=point --layers=topoPoint --prefix=TOPO_
```

`import-dir` перетворює кожен `*.svg` на запис (`code` з імені файла, `name` дописати вручну),
дублі пропускає. Імпорт тільки з-під `public/`.

## Перевірки

```sh
npm run lint
npm run build
```

ArcGIS REST items/services приватні. Завантаження WebMap, схеми, редакторських capabilities та UTM-сумісності шарів потрібно перевірити після входу в організаційний Portal. При зміні WKID `MapView` може не відображати сервісний шар, якщо він не підтримує обрану просторову систему.
