// Сохранение партии для полного режима. Слот один на ROM: данные лежат
// в IndexedDB под ключом SHA-256, поэтому смена ROM не задевает чужой слот.
// Плюс синхронная копия для закрытия вкладки (localStorage), как в старом порте.

const DB_NAME = 'tetris-web-runs';
const STORE = 'slots';
const EXIT_KEY = 'tetris-web:exit:';

function exitCheckpoint(sha256) {
  try {
    const saved = JSON.parse(localStorage.getItem(EXIT_KEY + sha256));
    if (saved?.info && saved?.checkpoint) return saved;
  } catch { /* Storage может быть недоступен. */ }
  return null;
}

export function saveOnExit(sha256, info, checkpoint) {
  // Закрытие вкладки может оборвать асинхронную транзакцию IndexedDB.
  // Синхронная копия закрывает этот зазор; основной снапшот — в IDB.
  try {
    localStorage.setItem(EXIT_KEY + sha256, JSON.stringify({ info, checkpoint }));
  } catch { /* периодический checkpoint в IDB остаётся */ }
}

function clearExitCheckpoint(sha256, id, owner) {
  try {
    const saved = JSON.parse(localStorage.getItem(EXIT_KEY + sha256));
    if (saved?.info?.id === id && saved.info.owner === owner) localStorage.removeItem(EXIT_KEY + sha256);
  } catch { /* ничего */ }
}

/**
 * Открывает хранилище партий. `null` — IndexedDB недоступна, играем без сохранений.
 * @param {string} sha256 SHA-256 ROM игрока
 */
export function openSavedRun(sha256) {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB || !sha256) return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onerror = request.onblocked = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch { /* уже закрыта */ }
      };
      resolve(new RunStore(db, sha256));
    };
  });
}

class RunStore {
  constructor(db, sha256) {
    this.db = db;
    this.sha256 = sha256;
    this.key = 'run:' + sha256;
  }

  transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(STORE, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('run store aborted'));
      operation(tx.objectStore(STORE), (value) => { result = value; });
    });
  }

  async readSlot() {
    return this.transaction('readonly', (store, set) => {
      const request = store.get(this.key);
      request.onsuccess = () => set(request.result ?? null);
    });
  }

  async read() {
    const slot = await this.readSlot();
    if (!slot?.info) return null;
    const backup = exitCheckpoint(this.sha256);
    return backup?.info?.id === slot.info.id ? backup.info : slot.info;
  }

  save(info, checkpoint, initial) {
    return this.transaction('readwrite', (store, set) => {
      const write = () => {
        store.put({ info, checkpoint, initial: initial ?? null }, this.key);
        set(info);
      };
      if (initial) {
        write();
        return;
      }
      const request = store.get(this.key);
      request.onsuccess = () => {
        const saved = request.result;
        // Вкладка от заменённой партии не может перезаписать слот.
        if (!saved?.info || (saved.info.id === info.id && saved.info.owner === info.owner)) write();
        else set(saved.info ?? null);
      };
    });
  }

  take(id, owner) {
    let consumedOwner = null;
    return this.transaction('readwrite', (store, set) => {
      const request = store.get(this.key);
      request.onsuccess = () => {
        const slot = request.result;
        if (slot?.info?.id !== id) return set(null);
        const backup = exitCheckpoint(this.sha256);
        const info = { ...(backup?.info ?? slot.info), owner };
        if (!slot.checkpoint) return set(null);
        const state = backup?.checkpoint ?? slot.checkpoint;
        if (backup) {
          consumedOwner = backup.info.owner;
          store.put({ ...slot, checkpoint: state }, this.key);
        }
        set({ info, checkpoint: state, initial: slot.initial ?? null });
      };
    }).then((result) => {
      if (consumedOwner) clearExitCheckpoint(this.sha256, id, consumedOwner);
      return result;
    });
  }

  finish(id, owner) {
    return this.transaction('readwrite', (store, set) => {
      const request = store.get(this.key);
      request.onsuccess = () => {
        if (request.result?.info?.id === id && request.result.info.owner === owner) {
          store.delete(this.key);
          set(null);
        } else set(request.result?.info ?? null);
      };
    }).then((info) => {
      if (!info) clearExitCheckpoint(this.sha256, id, owner);
      return info;
    });
  }

  clear() {
    return this.transaction('readwrite', (store) => store.delete(this.key)).catch(() => {});
  }
}
