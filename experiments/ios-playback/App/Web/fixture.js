export const marker = 'gate1-v1';

// Each store must read its own prior marker and complete its write before reporting.
export async function checkStorage(result) {
    try {
        result.localStorage = localStorage.getItem('marker');
        localStorage.setItem('marker', marker);
    } catch (e) { result.localError = String(e); }
    const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('gate1', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('markers');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction('markers', 'readwrite');
            const store = tx.objectStore('markers');
            const read = store.get('marker');
            read.onsuccess = () => {
                result.indexedDB = read.result ?? null;
                store.put(marker, 'marker');
            };
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}
