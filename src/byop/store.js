// Локальное хранилище BYOP-оболочки: IndexedDB, база `tetris-web`.
// Здесь только данные игрока: байты его ROM, паспорт, обложка из ROM,
// кэш скомпилированной программы и menu-checkpoint. Ничего не уходит в сеть.
//
// В git эти данные не попадают: браузерная база живёт на устройстве игрока.

const DB_NAME = 'tetris-web';
const DB_VERSION = 1;
const STORES = ['rom', 'covers', 'programs', 'checkpoints', 'meta'];
const ACTIVE_KEY = 'activeRom';

/** Ошибка хранилища с машинным кодом для человеческих текстов в UI. */
export class ByopStoreError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ByopStoreError';
    this.code = code;
    this.detail = detail;
  }
}

let connection = null;
let opening = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Ошибки IndexedDB приводим к кодам, которые UI умеет объяснять.
 * @param {unknown} error
 */
export function storageError(error, fallbackCode = 'unknown') {
  if (error instanceof ByopStoreError) return error;
  const name = error?.name ?? '';
  let code = fallbackCode;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') code = 'quota';
  else if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') code = 'blocked';
  else if (name === 'VersionError' || name === 'AbortError') code = 'unavailable';
  else if (!globalThis.indexedDB) code = 'unsupported';
  const detail = error?.message ?? String(error ?? '');
  return new ByopStoreError(code, detail || 'IndexedDB operation failed', detail);
}

/** Открывает (и при необходимости создаёт) базу `tetris-web`. */
export function openStore() {
  if (connection) return Promise.resolve(connection);
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new ByopStoreError('unsupported', 'IndexedDB is not available'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'sha' });
        }
      }
      // Свежая база: запоминаем, какие хранилища уже есть у прошлых версий.
      const store = request.transaction.objectStore('meta');
      store.put({ key: 'schema', value: DB_VERSION, updatedAt: Date.now() });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        connection = null;
        try { db.close(); } catch { /* уже закрыта */ }
      };
      connection = new Store(db);
      opening = null;
      resolve(connection);
    };
    request.onerror = () => {
      opening = null;
      reject(storageError(request.error));
    };
    request.onblocked = () => {
      opening = null;
      reject(new ByopStoreError('blocked', 'IndexedDB upgrade is blocked by another tab'));
    };
  });
  return opening;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && value.bytes) return toBytes(value.bytes);
  throw new ByopStoreError('type', 'Program bytes expected');
}

class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    if (connection === this) connection = null;
    try { this.db.close(); } catch { /* уже закрыта */ }
  }

  run(storeNames, mode, operation) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(storeNames, mode);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(storageError(tx.error ?? new Error('Transaction aborted')));
      tx.onerror = () => reject(storageError(tx.error));
      try {
        operation(...storeNames.map(name => tx.objectStore(name)), value => { result = value; });
      } catch (error) {
        try { tx.abort(); } catch { /* пустая транзакция */ }
        reject(storageError(error));
      }
    });
  }

  // --- активный ROM ---------------------------------------------------------

  /** Метаданные активного ROM без байтов (для карточки и меню). */
  async getActiveRom() {
    const meta = await this.run(['meta'], 'readonly', (store, set) => {
      const request = store.get(ACTIVE_KEY);
      request.onsuccess = () => set(request.result?.sha ?? null);
    });
    if (!meta) return null;
    return this.getRom(meta);
  }

  /** Активные байты ROM или null. */
  async getActiveRomBytes() {
    const info = await this.getActiveRom();
    if (!info?.sha) return null;
    return this.getRomBytes(info.sha);
  }

  /** Запись ROM: метаданные + байты + активность в одной транзакции. */
  saveRom({ sha, name = '', size = 0, profile = null, bytes }) {
    if (!sha) return Promise.reject(new ByopStoreError('type', 'sha is required'));
    const record = {
      sha,
      name,
      size: size || bytes?.byteLength || 0,
      addedAt: Date.now(),
      profile,
      bytes: toBytes(bytes).slice()
    };
    return this.run(['rom', 'meta'], 'readwrite', (roms, meta, set) => {
      roms.put(record);
      meta.put({ key: ACTIVE_KEY, sha, updatedAt: Date.now() });
      set({ ...record, bytes: undefined });
    });
  }

  setActiveRom(sha) {
    return this.run(['rom', 'meta'], 'readwrite', (roms, meta, set) => {
      const request = roms.get(sha);
      request.onsuccess = () => {
        if (!request.result) return set(null);
        meta.put({ key: ACTIVE_KEY, sha, updatedAt: Date.now() });
        set({ ...request.result, bytes: undefined });
      };
    });
  }

  getRom(sha) {
    return this.run(['rom'], 'readonly', (roms, set) => {
      const request = roms.get(sha);
      request.onsuccess = () => {
        const record = request.result ?? null;
        set(record ? { ...record, bytes: undefined } : null);
      };
    });
  }

  getRomBytes(sha) {
    return this.run(['rom'], 'readonly', (roms, set) => {
      const request = roms.get(sha);
      request.onsuccess = () => set(request.result?.bytes ? toBytes(request.result.bytes).slice() : null);
    });
  }

  /** Удаляет все производные данные ROM: байты, обложку, кэш, checkpoint. */
  async deleteRomData(sha) {
    return this.run(['rom', 'covers', 'programs', 'checkpoints', 'meta'], 'readwrite', (roms, covers, programs, checkpoints, meta, set) => {
      roms.delete(sha);
      covers.delete(sha);
      programs.delete(sha);
      checkpoints.delete(sha);
      const request = meta.get(ACTIVE_KEY);
      request.onsuccess = () => {
        if (request.result?.sha === sha) meta.delete(ACTIVE_KEY);
        set(true);
      };
    });
  }

  /** Сбрасывает всё производное (обложка, WASM-кэш, checkpoint), оставляя ROM. */
  resetDerivedData(sha) {
    if (!sha) return Promise.resolve(false);
    return this.run(['covers', 'programs', 'checkpoints'], 'readwrite', (covers, programs, checkpoints) => {
      covers.delete(sha);
      programs.delete(sha);
      checkpoints.delete(sha);
    }).then(() => true);
  }

  async clearAll() {
    return this.run(STORES, 'readwrite', (...stores) => {
      for (const store of stores) store.clear();
    });
  }

  // --- обложка (титульный кадр из ROM, только в браузере) -------------------

  saveCover(sha, dataUrl) {
    if (!sha) return Promise.reject(new ByopStoreError('type', 'sha is required'));
    return this.run(['covers'], 'readwrite', (covers, set) => {
      covers.put({ sha, dataUrl, createdAt: Date.now() });
      set(true);
    });
  }

  getCover(sha) {
    return this.run(['covers'], 'readonly', (covers, set) => {
      const request = covers.get(sha);
      request.onsuccess = () => set(request.result?.dataUrl ?? null);
    });
  }

  deleteCover(sha) {
    return this.run(['covers'], 'readwrite', (covers) => covers.delete(sha));
  }

  // --- кэш скомпилированной программы (WASM-байты) по SHA ROM --------------

  /**
   * Кэш скомпилированного WASM. Движок принимает и возвращает объект
   * `{ romSha256, wasm: Uint8Array, schema: 1 }`; Uint8Array тоже допустим.
   * @param {string} sha
   * @param {{romSha256?: string, wasm: Uint8Array|ArrayBuffer}|Uint8Array|ArrayBuffer} program
   */
  async putCachedProgram(sha, program) {
    if (!sha) throw new ByopStoreError('type', 'sha is required');
    const source = program && !(program instanceof Uint8Array) && !(program instanceof ArrayBuffer) && !ArrayBuffer.isView(program)
      ? program
      : { wasm: program };
    const wasm = toBytes(source.wasm ?? source.bytes ?? source).slice();
    const record = {
      sha,
      romSha256: typeof source.romSha256 === 'string' ? source.romSha256 : sha,
      schema: source.schema ?? 1,
      wasm,
      size: wasm.byteLength,
      updatedAt: Date.now()
    };
    await this.run(['programs'], 'readwrite', (store, set) => {
      store.put(record);
      set(true);
    });
    return { romSha256: record.romSha256, wasm, schema: record.schema };
  }

  /** @returns {Promise<{romSha256: string, wasm: Uint8Array, schema: number}|null>} */
  async getCachedProgram(sha) {
    const record = await this.run(['programs'], 'readonly', (store, set) => {
      const request = store.get(sha);
      request.onsuccess = () => set(request.result ?? null);
    });
    if (!record?.wasm) return null;
    try {
      return {
        romSha256: record.romSha256 ?? sha,
        wasm: toBytes(record.wasm).slice(),
        schema: record.schema ?? 1
      };
    } catch {
      return null;
    }
  }

  deleteCachedProgram(sha) {
    return this.run(['programs'], 'readwrite', (store) => store.delete(sha));
  }

  // --- menu-checkpoint «сразу в меню» ---------------------------------------

  /** @param {{schema:number, stateVersion:*, state:any}} payload */
  putMenuCheckpoint(sha, payload) {
    if (!sha) return Promise.reject(new ByopStoreError('type', 'sha is required'));
    return this.run(['checkpoints'], 'readwrite', (store, set) => {
      store.put({
        sha,
        schema: payload.schema ?? 1,
        stateVersion: payload.stateVersion ?? null,
        state: payload.state,
        savedAt: Date.now()
      });
      set(true);
    });
  }

  getMenuCheckpoint(sha) {
    return this.run(['checkpoints'], 'readonly', (store, set) => {
      const request = store.get(sha);
      request.onsuccess = () => set(request.result ?? null);
    });
  }

  deleteMenuCheckpoint(sha) {
    return this.run(['checkpoints'], 'readwrite', (store) => store.delete(sha));
  }

  // --- постоянное хранилище и квоты ----------------------------------------

  /** Просит браузер не вычищать базу при нехватке места. */
  async requestPersist() {
    try {
      if (!navigator.storage?.persist) return false;
      return Boolean(await navigator.storage.persist());
    } catch {
      return false;
    }
  }

  async persisted() {
    try {
      if (!navigator.storage?.persisted) return false;
      return Boolean(await navigator.storage.persisted());
    } catch {
      return false;
    }
  }

  /** @returns {Promise<{usage:number, quota:number, ratio:number}|null>} */
  async estimate() {
    try {
      if (!navigator.storage?.estimate) return null;
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
    } catch {
      return null;
    }
  }
}

export function isStorageSupported() {
  return Boolean(globalThis.indexedDB);
}
