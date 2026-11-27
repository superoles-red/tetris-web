import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeZip, extractNesFromZip } from '../src/byop/zip.js';

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.forEach((b, i) => { local[30 + i] = b; });
    data.forEach((b, i) => { local[30 + nameBytes.length + i] = b; });
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.forEach((b, i) => { central[46 + i] = b; });
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}

test('ZIP: находит ROM внутри архива', async () => {
  const rom = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, ...new Array(60).fill(0)]);
  const zip = storedZip([
    { name: 'readme.txt', data: new Uint8Array([1, 2, 3]) },
    { name: 'roms/tetris.nes', data: rom }
  ]);
  assert.equal(looksLikeZip(zip), true);
  const entries = await extractNesFromZip(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'roms/tetris.nes');
  assert.deepEqual([...entries[0].bytes], [...rom]);
});

test('ZIP: архив без .nes отклоняется', async () => {
  assert.equal(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), true);
  const zip = storedZip([{ name: 'notes.txt', data: new Uint8Array([5]) }]);
  assert.deepEqual(await extractNesFromZip(zip), []);
});
