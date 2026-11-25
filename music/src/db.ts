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
 * VERSION STRATEGY: on version bump, all existing stores are deleted and
 * recreated. Safe because all cached data rebuilds from OneDrive.
 * Audio key format: "driveId:itemId".
 */

const DB_VERSION = 2;

/** Opens (or creates) the database. Caller must close when done. */
const dbOpen = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open('oneplay-music-cache', DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = request.result;
            // Wipe all existing stores on upgrade (safe: all data rebuilds from OneDrive)
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
export async function dbPut(key: string, value: unknown): Promise<void> {
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
export async function dbKeysWithPrefix(prefix: string): Promise<string[]> {
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
export async function dbGet<T>(key: string): Promise<T | undefined> {
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
export async function dbClear(): Promise<void> {
    const db = await dbOpen();
    try {
        await new Promise<void>((resolve, reject) => {
            const req = db.transaction('data', 'readwrite').objectStore('data').clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

/** Deletes a value by key from the data store. */
export async function dbDelete(key: string): Promise<void> {
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
export async function audioPut(key: string, blob: Blob): Promise<void> {
    const db = await dbOpen();
    try {
        await new Promise<void>((resolve, reject) => {
            const req = db.transaction('audio', 'readwrite').objectStore('audio').put(blob, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

/** Retrieves an audio blob by key, or undefined if absent. */
export async function audioGet(key: string): Promise<Blob | undefined> {
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

/** Deletes an audio blob by key. */
export async function audioDelete(key: string): Promise<void> {
    const db = await dbOpen();
    try {
        await new Promise<void>((resolve, reject) => {
            const req = db.transaction('audio', 'readwrite').objectStore('audio').delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

/** Returns all keys in the audio store. */
export async function audioKeys(): Promise<string[]> {
    const db = await dbOpen();
    try {
        return await new Promise<string[]>((resolve, reject) => {
            const req = db.transaction('audio', 'readonly').objectStore('audio').getAllKeys();
            req.onsuccess = () => resolve(req.result as string[]);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

/** Returns the total size in bytes of all audio blobs (cursor walk). */
export async function audioTotalBytes(): Promise<number> {
    const db = await dbOpen();
    try {
        return await new Promise<number>((resolve, reject) => {
            let total = 0;
            const req = db.transaction('audio', 'readonly').objectStore('audio').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    const blob = cursor.value as Blob;
                    total += blob.size;
                    cursor.continue();
                } else {
                    resolve(total);
                }
            };
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

/** Wipes every entry in the audio store. */
export async function audioClear(): Promise<void> {
    const db = await dbOpen();
    try {
        await new Promise<void>((resolve, reject) => {
            const req = db.transaction('audio', 'readwrite').objectStore('audio').clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}
