/**
 * Logging module for OnePlay Music — environment-agnostic core.
 *
 * INVARIANT: the stable wrapper exports (log, logError, logCatch, logClear)
 * never change identity. They close over the mutable `impl` reference, so
 * captured references always dispatch correctly through the current impl.
 *
 * INVARIANT: every entrypoint must call setLogImpl() (or accept the console
 * default) before any logging occurs. In the browser, index.ts calls
 * initWebLogger() which sets the browser quad-write impl. In Node tests,
 * the default console impl is sufficient, or tests can inject a mock.
 *
 * This module has no browser globals (window, document, localStorage) at
 * module scope, making it safe to import in Node for unit testing.
 */

/** Signature for the swappable logging implementation. */
export type LogImpl = (type: 'info' | 'error', message: string) => void;

/** Signature for the swappable clear implementation. */
export type ClearImpl = () => void;

/**
 * Default impl: console-only. Sufficient for Node tests; overridden by
 * initWebLogger() in the browser for quad-write (console, window array,
 * DOM panel, localStorage).
 */
let impl: LogImpl = (type, msg) =>
    type === 'error' ? console.error(msg) : console.log(msg);

/** Default clear: no-op. Overridden by initWebLogger() in the browser. */
let clearImpl: ClearImpl = () => {};

/** Replaces the logging implementation. Called once at startup. */
export const setLogImpl = (fn: LogImpl): void => { impl = fn; };

/** Replaces the clear implementation. Called once at startup. */
export const setClearImpl = (fn: ClearImpl): void => { clearImpl = fn; };

/** Log an informational message. */
export const log = (message: string): void => impl('info', message);

/** Log an error message. */
export const logError = (message: string): void => impl('error', message);

/** Short description of a caught value.
 *  Use for user-facing copy or coarse error classification where compact,
 *  stable text is preferred over stack traces. */
export const errorMessage = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

/** Detailed description of a caught value — includes stack when available.
 *  Error.stack already contains the message as its first line, so this is
 *  a strict superset of errorMessage. Use for diagnostics/logs/telemetry. */
export const errorDetail = (e: unknown): string =>
    e instanceof Error && e.stack ? e.stack : errorMessage(e);

/**
 * Returns a catch handler that logs the caught value and returns a
 * human-readable error string. Usage: `.catch(logCatch("context"))`.
 *
 * Logs the full stack trace (via errorDetail) for diagnostics, but returns
 * only the short message so callers can use it in user-facing UI.
 */
export const logCatch = (context: string) => (e: unknown): string => {
    const message = errorMessage(e);
    logError(`${context}: ${errorDetail(e)}`);
    return message;
};

/** Clears all log destinations. Delegates to the current clearImpl. */
export const logClear = (): void => clearImpl();
