# M1 Plan: Development Infrastructure

## Context

Milestone 1 establishes the build-serve-deploy-test loop. The page doesn't need to do anything functional -- it proves that TypeScript compiles, the dev server works, deployment works, Playwright can interact with the page, and logging is readable by the AI agent. Currently the project root has no source files at all.

## Files to Create

Seven new files at project root, plus copy three icon files from `example/`.

### 1. `package.json`

- Scripts: `build` (tsc), `watch` (tsc --watch), `serve` (serve -l 5500 -n), `deploy` (build + rsync)
- devDependencies: `typescript ^5.7`, `serve ^14`
- The deploy script uses the exact rsync command from MILESTONES.md
- Install via sandbox-escape: `cd /Users/ljw/code/mymusic2 && npm install`

### 2. `tsconfig.json`

- `target: "ES2022"`, `module: "ES2022"` -- native ES modules, no bundler. Safari 16.4+ (iOS 16.4, March 2023) supports ES2022.
- `moduleResolution: "bundler"` -- works for browser ES modules where imports use `.js` extensions
- `outDir: "dist"`, `rootDir: "."`, `sourceMap: true`, `strict: true`
- `lib: ["ES2022", "DOM", "DOM.Iterable"]`
- `include: ["*.ts"]`, `exclude: ["node_modules", "dist", "example"]`
- All local imports in `.ts` files must use `.js` extensions (e.g. `import { log } from './logger.js'`) since the browser resolves them literally and tsc doesn't rewrite extensions.

### 3. `logger.ts`

Provides `log()`, `logCatch()`, `logError()` matching the API used throughout `example/`.

**INVARIANT: every log entry is written to four places:**
1. `console.log` / `console.error` -- for browser DevTools
2. `window.__MYMUSIC_LOGS` array -- for Playwright `page.evaluate()`
3. `#log-panel` DOM element -- for visual inspection / screenshots
4. `localStorage` key `"mymusic_logs"` -- survives page navigations (e.g. OneDrive auth redirects)

Single internal `appendLog(level, message)` function handles the quad-write with `HH:MM:SS.mmm` timestamps.

**Persistence via localStorage:**
- On each `appendLog`, the full `LOG_ENTRIES` array is written to `localStorage.setItem("mymusic_logs", JSON.stringify(LOG_ENTRIES))`.
- On module load, any previous entries are read from `localStorage.getItem("mymusic_logs")`, parsed, pushed into `LOG_ENTRIES`, and rendered into `#log-panel` (deferred until DOM ready). This means after an OAuth redirect, the AI can see pre-redirect logs.
- A `logClear()` export clears all four destinations.
- localStorage is synchronous and string-shaped, which is ideal for logging -- no `await` needed, no IndexedDB complexity.

### 4. `index.ts`

Minimal stub:
- Imports `log` from `./logger.js`
- Exports `async function onBodyLoad()` which logs "onBodyLoad", sets `#status` text to "Ready", logs "page ready"

### 5. `index.html`

Single-file SPA shell with inline CSS (per AGENTS.md: "index.html contains all HTML and CSS"):
- PWA meta tags: viewport with `viewport-fit=cover`, `apple-mobile-web-app-capable`, `mobile-web-app-capable`
- `<link rel="manifest" href="manifest.json">`, icon links
- `<script type="module">` importing `onBodyLoad` from `./dist/index.js`, called on DOMContentLoaded
- `#status` div (centered, shows "Loading..." then "Ready")
- `#log-panel` div (fixed bottom, green-on-black monospace, hidden when empty via `:empty`)
- Minimal CSS: full-height flexbox, safe-area-insets, box-sizing

### 6. `manifest.json`

PWA manifest: `name: "MyMusic"`, `display: "standalone"`, `start_url: "."`, `background_color: "#000000"`, icons referencing `appicon.png` (192x192) and `bigicon.png` (512x512).

### 7. Copy icons from `example/`

- `example/appicon.png` -> `appicon.png`
- `example/bigicon.png` -> `bigicon.png`
- `example/favicon.png` -> `favicon.png`

## Implementation Sequence

1. Create `package.json`, `tsconfig.json`
2. `npm install` via sandbox-escape
3. Copy icons from `example/`
4. Create `manifest.json`, `logger.ts`, `index.ts`, `index.html`
5. `npm run build` -- compiles TS to `dist/`
6. Start `npm run serve` in background
7. Playwright validation on localhost (screenshot + programmatic check)
8. `npm run deploy` via sandbox-escape
9. Playwright validation on production
10. Human validates PWA install on iPhone

## Validation

**Playwright localhost test** (via sandbox-escape Node script):
- Navigate to `http://localhost:5500`
- Assert `#status` text is "Ready"
- Assert `window.__MYMUSIC_LOGS` has >= 2 entries
- Assert `#log-panel` contains log text
- Take screenshot to `/tmp/mymusic-local.png`

**Playwright production test**: same checks against `https://unto.me/mymusic/`

**Human validation**: install PWA on iPhone from production URL, verify it opens standalone.

## Not Included (deferred)

- No service worker (M10)
- No test framework (Playwright via sandbox-escape is the testing mechanism)
- No webpack/bundler (architecture constraint: browser loads ES modules natively)
