/** Opens IndexedDB database `name` with its one object store `store`; null when this browser has none or refuses it. */
export function openStore(name: string, store: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(store);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
