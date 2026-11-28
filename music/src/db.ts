/**
 * IndexedDB cache for OnePlay Music.
 *
 * Provides a simple key-value store backed by IndexedDB. The database
 * ("oneplay-music-cache") has two object stores: "data" (general cache) and
 * "audio" (offline audio blobs). String keys in both stores.
 *
 * INVARIANT: every operation opens and closes the database per call,
 * so we never hold a long-lived connection that might block upgrades.
 *
 * The personal cache retains its existing rebuild-on-upgrade policy. Demo v1
 * contains device-only favorites and pins and needs a preserving migration before any version bump.
 * Audio key format: "driveId:itemId".
 */

const DB_VERSION = 2;

/** Open independent stores using the same transaction and inventory rules. */
export function createMusicDatabase(name: string, version: number) {
    /** Opens (or creates) the database. Caller must close when done. */
    const dbOpen = (): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
            const request = indexedDB.open(name, version);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = request.result;
                // The personal cache can rebuild from its remote documents. Demo v1 has no upgrades.
                if ((event as IDBVersionChangeEvent).oldVersion > 0) {
                    for (const name of Array.from(db.objectStoreNames)) {
                        db.deleteObjectStore(name);
                    }
                }
                db.createObjectStore('data');
                db.createObjectStore('audio');
            };
        });

    /** Stores a value under the given key. */
    async function dbPut(key: string, value: unknown): Promise<void> {
        const db = await dbOpen();
        try {
            await new Promise<void>((resolve, reject) => {
                const transaction = db.transaction('data', 'readwrite');
                // A successful put can still roll back. Callers may acknowledge a library edit on return.
                transaction.oncomplete = () => resolve();
                transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
                transaction.objectStore('data').put(value, key);
            });
        } finally {
            db.close();
        }
    }

    /** Discover legacy private positions without reading every favorite or loading unrelated index data. */
    async function dbKeysWithPrefix(prefix: string): Promise<string[]> {
        const db = await dbOpen();
        try {
            return await new Promise<string[]>((resolve, reject) => {
                const store = db.transaction('data', 'readonly').objectStore('data');
                const request = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'));
                request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
                request.onerror = () => reject(request.error);
            });
        } finally { db.close(); }
    }

    /** Retrieves the value for the given key, or undefined if absent. */
    async function dbGet<T>(key: string): Promise<T | undefined> {
        const db = await dbOpen();
        try {
            return await new Promise<T | undefined>((resolve, reject) => {
                const req = db.transaction('data', 'readonly').objectStore('data').get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } finally {
            db.close();
        }
    }

    /** Wipes every entry in the data store (e.g. on sign-out). */
    async function dbClear(): Promise<void> {
        const db = await dbOpen();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction('data', 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error ?? new Error('Library cache clear aborted'));
                tx.objectStore('data').clear();
            });
        } finally {
            db.close();
        }
    }

    /** Deletes a value by key from the data store. */
    async function dbDelete(key: string): Promise<void> {
        const db = await dbOpen();
        try {
            await new Promise<void>((resolve, reject) => {
                const req = db.transaction('data', 'readwrite').objectStore('data').delete(key);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        } finally {
            db.close();
        }
    }

    // ---------------------------------------------------------------------------
    // Audio store — offline audio blobs keyed by "driveId:itemId"
    // ---------------------------------------------------------------------------

    /** Stores an audio blob under the given key. */
    async function audioPut(key: string, blob: Blob): Promise<void> {
        const db = await dbOpen();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction('audio', 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error ?? new Error('Audio cache transaction aborted'));
                tx.objectStore('audio').put(blob, key);
            });
        } finally {
            db.close();
        }
    }

    /** Retrieves an audio blob by key, or undefined if absent. */
    async function audioGet(key: string): Promise<Blob | undefined> {
        const db = await dbOpen();
        try {
            return await new Promise<Blob | undefined>((resolve, reject) => {
                const req = db.transaction('audio', 'readonly').objectStore('audio').get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } finally {
            db.close();
        }
    }

    /** Delete the unowned files in one transaction. The caller updates its inventory after the commit. */
    async function audioDeleteBatch(keys: readonly string[]): Promise<void> {
        const db = await dbOpen();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction('audio', 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error ?? new Error('Audio cache transaction aborted'));
                const store = tx.objectStore('audio');
                for (const key of keys) store.delete(key);
            });
        } finally { db.close(); }
    }

    /** Reads keys and blob sizes in one cursor pass without loading audio bytes into JS. */
    async function audioFileSizes(): Promise<Map<string, number>> {
        const db = await dbOpen();
        try {
            return await new Promise<Map<string, number>>((resolve, reject) => {
                const sizes = new Map<string, number>();
                const req = db.transaction('audio', 'readonly').objectStore('audio').openCursor();
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (cursor) {
                        sizes.set(cursor.key as string, (cursor.value as Blob).size);
                        cursor.continue();
                    } else resolve(sizes);
                };
                req.onerror = () => reject(req.error);
            });
        } finally { db.close(); }
    }

    /** Wipes every entry in the audio store. */
    async function audioClear(): Promise<void> {
        const db = await dbOpen();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction('audio', 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error ?? new Error('Audio cache transaction aborted'));
                tx.objectStore('audio').clear();
            });
        } finally {
            db.close();
        }
    }

    return { dbPut, dbKeysWithPrefix, dbGet, dbClear, dbDelete, audioPut, audioGet, audioDeleteBatch, audioFileSizes, audioClear };
}

export const { dbPut, dbKeysWithPrefix, dbGet, dbClear, dbDelete, audioPut, audioGet, audioDeleteBatch, audioFileSizes, audioClear } = createMusicDatabase('oneplay-music-cache', DB_VERSION);
