/**
 * Browser-specific logging implementation for OnePlay Music.
 *
 * Contains the quad-write logic (console, window.__ONEPLAY_MUSIC_LOGS, #log-panel,
 * localStorage) and the localStorage restore-on-load logic that were
 * previously in logger.ts.
 *
 * INVARIANT: initWebLogger() must be called once at startup, before any
 * code that calls log/logError/logCatch. index.ts does this.
 *
 * INVARIANT: after initWebLogger(), every log entry is written to four places:
 * 1. console.log / console.error — for browser DevTools
 * 2. window.__ONEPLAY_MUSIC_LOGS array — for Playwright page.evaluate()
 * 3. #log-panel DOM element — for visual inspection / screenshots
 * 4. localStorage key "oneplay_music_logs" — survives page navigations (OAuth redirects)
 */

import { setLogImpl, setClearImpl } from './logger.js';

/** Shape of a single log entry. */
interface LogEntry {
    readonly time: string;
    readonly level: 'info' | 'error';
    readonly message: string;
}

/** Returns a "Sun 14:23:05.012" timestamp (day-of-week helps distinguish today vs restored). */
const timestamp = (): string => {
    const d = new Date();
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');
    return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
};

/** Prepends a formatted log entry div to the panel (newest at top). */
const addLogDiv = (panel: HTMLElement, entry: LogEntry): void => {
    const div = document.createElement('div');
    div.textContent = `[${entry.time}] ${entry.message}`;
    if (entry.level === 'error') div.style.color = '#f66';
    panel.prepend(div);
};

/**
 * Initializes the browser quad-write logging implementation.
 * Restores previous session logs from localStorage, then installs
 * the quad-write impl via setLogImpl/setClearImpl.
 *
 * Must be called once before any logging occurs.
 */
export function initWebLogger(): void {
    /** Module-level array, also exposed as window.__ONEPLAY_MUSIC_LOGS for Playwright. */
    const LOG_ENTRIES: LogEntry[] = [];
    (window as any).__ONEPLAY_MUSIC_LOGS = LOG_ENTRIES;

    // --- Restore previous session logs from localStorage (newest 300 only) ---
    const MAX_LOG_ENTRIES = 300;
    const restored: LogEntry[] = (() => {
        try {
            const raw = localStorage.getItem('oneplay_music_logs');
            const all = raw ? (JSON.parse(raw) as LogEntry[]) : [];
            return all.length > MAX_LOG_ENTRIES ? all.slice(-MAX_LOG_ENTRIES) : all;
        } catch {
            return [];
        }
    })();

    if (restored.length > 0) {
        for (const entry of restored) LOG_ENTRIES.push(entry);

        // Render restored entries into the DOM (newest first via prepend).
        const renderRestored = (): void => {
            const panel = document.getElementById('log-panel');
            if (!panel) return;
            for (const entry of restored) addLogDiv(panel, entry);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', renderRestored);
        } else {
            renderRestored();
        }
    }

    // --- Install quad-write impl ---
    setLogImpl((level, message) => {
        const entry: LogEntry = { time: timestamp(), level, message };
        LOG_ENTRIES.push(entry);

        // Cap in-memory log to prevent unbounded growth.
        if (LOG_ENTRIES.length > MAX_LOG_ENTRIES) LOG_ENTRIES.splice(0, LOG_ENTRIES.length - MAX_LOG_ENTRIES);

        // 1. Console
        const line = `[${entry.time}] ${entry.message}`;
        if (level === 'error') console.error(line);
        else console.log(line);

        // 2. window.__ONEPLAY_MUSIC_LOGS — already pushed above

        // 3. DOM panel (best-effort; element may not exist yet). Newest at top.
        const panel = document.getElementById('log-panel');
        if (panel) {
            addLogDiv(panel, entry);
            // Cap DOM children to match in-memory cap.
            while (panel.children.length > MAX_LOG_ENTRIES) panel.lastElementChild?.remove();
        }

        // 4. localStorage persistence
        try {
            localStorage.setItem('oneplay_music_logs', JSON.stringify(LOG_ENTRIES));
        } catch {
            // Storage full or unavailable — drop silently.
        }
    });

    // --- Install clear impl ---
    setClearImpl(() => {
        LOG_ENTRIES.length = 0;
        const panel = document.getElementById('log-panel');
        if (panel) panel.textContent = '';
        try {
            localStorage.removeItem('oneplay_music_logs');
        } catch {
            // Ignore.
        }
    });
}
