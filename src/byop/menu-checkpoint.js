// «Сразу в меню»: menu-checkpoint после первого успешного автозапуска.
// Храним состояние движка в состоянии меню, чтобы на следующем запуске
// не смотреть copyright-экран. Версия состояния проверяется движком при
// restoreStart (он бросает Error при несовпадении) — здесь дополнительно
// проверяем schema и SHA ROM, чтобы чужой чекпоинт не подсунуть.

export const CHECKPOINT_SCHEMA = 1;

/** Обёртка состояния для IndexedDB. */
export function createCheckpointRecord(state) {
  return {
    schema: CHECKPOINT_SCHEMA,
    romSha256: typeof state?.romSha256 === 'string' ? state.romSha256 : null,
    stateVersion: Number.isFinite(state?.stateVersion) ? state.stateVersion : null,
    state
  };
}

/** Подходит ли сохранённый чекпоинт текущему ROM (без попытки restore). */
export function checkpointMatches(record, sha256) {
  if (!record || record.schema !== CHECKPOINT_SCHEMA || !record.state) return false;
  if (record.romSha256 && sha256 && record.romSha256 !== sha256) return false;
  return true;
}

/** Сохраняет состояние меню (только полный режим, только известный дамп). */
export async function saveMenuCheckpoint(store, sha256, state) {
  if (!store || !sha256 || !state) return false;
  try {
    await store.putMenuCheckpoint(sha256, createCheckpointRecord(state));
    return true;
  } catch {
    return false;
  }
}

/** Читает и валидирует чекпоинт; битый/чужой сразу удаляет. */
export async function readMenuCheckpoint(store, sha256) {
  if (!store || !sha256) return null;
  let record = null;
  try {
    record = await store.getMenuCheckpoint(sha256);
  } catch {
    return null;
  }
  if (!record) return null;
  if (!checkpointMatches(record, sha256)) {
    clearMenuCheckpoint(store, sha256).catch(() => {});
    return null;
  }
  return record;
}

/**
 * Пытается восстановить меню. Движок сам проверяет версию/ROM и бросает
 * Error — тогда чекпоинт удаляем и возвращаем false, вызывающий делает reset().
 */
export async function restoreMenuCheckpoint(engine, store, sha256) {
  const record = await readMenuCheckpoint(store, sha256);
  if (!record) return false;
  try {
    engine.restoreStart(record.state);
    return true;
  } catch (error) {
    console.warn('menu-checkpoint rejected:', error?.message ?? error);
    clearMenuCheckpoint(store, sha256).catch(() => {});
    return false;
  }
}

export function clearMenuCheckpoint(store, sha256) {
  if (!store || !sha256) return Promise.resolve(false);
  return store.deleteMenuCheckpoint(sha256).then(() => true).catch(() => false);
}
