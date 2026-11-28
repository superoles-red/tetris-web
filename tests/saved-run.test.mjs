import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRestoreState } from '../saved-run.js';

const slot = { info: { id: 'run-1', owner: 'owner-a' }, checkpoint: 'slot-cp', initial: 'init' };

test('Continue использует exit-бэкап только от той же партии', () => {
  const backup = { info: { id: 'run-1', owner: 'owner-a' }, checkpoint: 'exit-cp' };
  const picked = pickRestoreState(slot, backup);
  assert.equal(picked.checkpoint, 'exit-cp');
  assert.equal(picked.consumedOwner, 'owner-a');
  assert.equal(picked.staleBackup, false);
});

test('exit-бэкап от другой партии игнорируется (не подменяет WITH на solo)', () => {
  const stale = { info: { id: 'old-solo', owner: 'owner-x' }, checkpoint: 'solo-cp' };
  const picked = pickRestoreState(slot, stale);
  assert.equal(picked.checkpoint, 'slot-cp');
  assert.equal(picked.consumedOwner, null);
  assert.equal(picked.staleBackup, true);
  assert.equal(picked.info.id, 'run-1');
});

test('Continue без exit-бэкапа берёт слот', () => {
  const picked = pickRestoreState(slot, null);
  assert.equal(picked.checkpoint, 'slot-cp');
  assert.equal(picked.staleBackup, false);
});

test('Нет слота — восстанавливать нечего', () => {
  assert.equal(pickRestoreState(null, null), null);
});

import { opponentFromRam } from '../src/byop/full-mode.js';

test('Режим из RAM картриджа: 0/3/4', () => {
  assert.equal(opponentFromRam(0), 'solo');
  assert.equal(opponentFromRam(3), 'vs');
  assert.equal(opponentFromRam(4), 'with');
  assert.equal(opponentFromRam(undefined), 'solo');
});
