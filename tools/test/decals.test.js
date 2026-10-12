'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeDds, downsample, alphaBlock } = require('../lib/img/dds');
const { encodePng, decodePng } = require('../lib/img/png');
const decals = require('../lib/decals');

// A 4x4 DXT5 texture: one block, alpha 255→0 ramp palette, colour white/black.
function tinyDxt5() {
  const header = Buffer.alloc(128);
  header.write('DDS ', 0, 'latin1');
  header.writeUInt32LE(124, 4);
  header.writeUInt32LE(4, 12); header.writeUInt32LE(4, 16);
  header.write('DXT5', 84, 'latin1');
  const block = Buffer.alloc(16);
  block[0] = 255; block[1] = 0;                 // alpha endpoints
  // all alpha indices 0 except the first pixel = 1 (alpha 0)
  block[2] = 1;
  block.writeUInt16LE(0xffff, 8); block.writeUInt16LE(0x0000, 10); // white, black
  block.writeUInt32LE(0x00000000, 12);          // every pixel colour 0 (white)
  return Buffer.concat([header, block]);
}

test('DXT5 decode', () => {
  const img = decodeDds(tinyDxt5());
  assert.equal(img.width, 4);
  assert.deepEqual([...img.data.subarray(0, 4)], [255, 255, 255, 0]);
  assert.deepEqual([...img.data.subarray(4, 8)], [255, 255, 255, 255]);
  assert.deepEqual(alphaBlock(Buffer.from([10, 200, 0, 0, 0, 0, 0, 0]), 0).slice(0, 2), [10, 10]);
});

test('downsample keeps colour under transparent neighbours', () => {
  const img = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
  const s = downsample(img, 1);
  assert.deepEqual([...s.data.subarray(0, 3)], [255, 0, 0]);
  assert.equal(s.data[3], 64);
});

test('PNG round trip', () => {
  const img = { width: 3, height: 2, data: new Uint8ClampedArray(Array.from({ length: 24 }, (_, i) => i * 10)) };
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 3);
  assert.deepEqual([...back.data], [...img.data]);
});

test('reward parsing: race from parent, texture defaults to the id, hidden flag', () => {
  const xml = `<Catalog>
    <CRewardDecal default="1" id="DECALZERG"><Race value="Zerg"/></CRewardDecal>
    <CRewardDecal id="Decal_Terran_0088_01" parent="DECALTERRAN"><IconFile value="$Decals5"/></CRewardDecal>
    <CRewardDecal id="QuickMatch_Decal" parent="DECALPROTOSS"><Flags index="Hidden" value="1"/><Texture value="Decal_Protoss_0002_01"/></CRewardDecal>
    <CRewardDecal id="Spray_X" parent="SPRAYUSEDECAL"/>
  </Catalog>`;
  assert.deepEqual(decals.parseRewards(xml), [
    { reward: 'Decal_Terran_0088_01', texture: 'Decal_Terran_0088_01', race: 'terran', hidden: false },
    { reward: 'QuickMatch_Decal', texture: 'Decal_Protoss_0002_01', race: 'protoss', hidden: true },
  ]);
  const names = decals.parseStrings('Reward/Name/Decal_Terran_0088_01=Cerberus\r\nUnit/Name/X=Y');
  assert.equal(names.get('Decal_Terran_0088_01'), 'Cerberus');
  assert.equal(names.size, 1);
});

test('classify: blank and self-coloured tiles', () => {
  const tile = (rgba) => ({ data: new Uint8ClampedArray(Array.from({ length: 64 * 64 }, () => rgba).flat()) });
  assert.deepEqual(decals.classify(tile([255, 255, 255, 0])), { blank: true, colored: false });
  assert.deepEqual(decals.classify(tile([200, 200, 200, 255])), { blank: false, colored: false });
  assert.deepEqual(decals.classify(tile([230, 40, 30, 255])), { blank: false, colored: true });
});
