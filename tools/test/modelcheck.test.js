'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mc = require('../lib/modelcheck');

// A minimal MD34 .m3: header, the strings as CHAR entries, then the tag index.
function fakeM3(strings) {
  const chunks = [Buffer.alloc(16)];
  const index = [];
  let at = 16;
  for (const s of strings) {
    const b = Buffer.from(`${s}\0`, 'latin1');
    index.push({ tag: 'RAHC', at, n: b.length });
    chunks.push(b);
    at += b.length;
  }
  const idx = Buffer.alloc(16 * index.length);
  index.forEach((e, i) => { idx.write(e.tag, i * 16, 'latin1'); idx.writeUInt32LE(e.at, i * 16 + 4); idx.writeUInt32LE(e.n, i * 16 + 8); });
  chunks[0].write('43DM', 0, 'latin1');
  chunks[0].writeUInt32LE(at, 4);
  chunks[0].writeUInt32LE(index.length, 8);
  return Buffer.concat([...chunks, idx]);
}

test('m3Textures reads CHAR entries, texture paths only', () => {
  const buf = fakeM3(['Ref_Center', 'Assets/Textures/A@Diff.dds', 'es/Assets/Textures/B.dds', 'Assets\\Textures\\C.tga']);
  assert.deepEqual(mc.m3Textures(buf), ['Assets/Textures/A@Diff.dds', 'es/Assets/Textures/B.dds', 'Assets\\Textures\\C.tga']);
});

test('assetKey and refKey agree on the game path form', () => {
  assert.equal(mc.assetKey('Base.SC2Assets\\Assets\\Textures\\X.dds'), 'assets/textures/x.dds');
  assert.equal(mc.assetKey('enUS.SC2Assets/Assets/Textures/X.dds'), 'assets/textures/x.dds');
  assert.equal(mc.assetKey('Evo_Decal.m3'), 'evo_decal.m3');
  assert.equal(mc.refKey('Assets\\Textures\\X.dds'), 'assets/textures/x.dds');
  assert.equal(mc.refKey('F:\\Modding\\Assets\\Textures\\X.dds'), null);
});

test('resolveModel: parent templates, tokens, attributes and variations', () => {
  const cat = new Map();
  mc.addModels(cat, mc.parseModels(`<Catalog>
    <CModel default="1" id="Unit">
      <?token id="Race" value="Neutral"?>
      <?token id="Prefix" value="Units\\"?>
      <Model value="Assets\\##Prefix####Race##\\##id##\\##id##.m3"/>
    </CModel>
    <CModel default="1" id="Doodad"><Model value="Assets\\Doodads\\##id##\\##id##.m3"/></CModel>
    <CModel id="Lab" parent="Unit" Race="Resources"><Model value="Assets\\Lab\\Lab.m3"/></CModel>
  </Catalog>`));
  mc.addModels(cat, mc.parseModels(`<Catalog>
    <CModel id="MarineSCBW" parent="Unit"><?token id="Race" value="Terran"?></CModel>
    <CModel id="Rocks" parent="Doodad"><VariationCount value="3"/></CModel>
    <CModel id="One" parent="Doodad"><VariationCount value="1"/></CModel>
    <CModel id="LabChild" parent="Lab"/>
    <CModel id="Orphan"/>
  </Catalog>`));
  const lookup = (id) => cat.get(id) || [];
  assert.deepEqual(mc.resolveModel('MarineSCBW', lookup), ['Assets\\Units\\Terran\\MarineSCBW\\MarineSCBW.m3']);
  assert.deepEqual(mc.resolveModel('Rocks', lookup), ['_00', '_01', '_02'].map((s) => `Assets\\Doodads\\Rocks\\Rocks${s}.m3`));
  assert.deepEqual(mc.resolveModel('One', lookup), ['Assets\\Doodads\\One\\One.m3']);
  assert.deepEqual(mc.resolveModel('LabChild', lookup), ['Assets\\Lab\\Lab.m3']);
  assert.equal(mc.resolveModel('Orphan', lookup), null);
});

test('literalRefs skips CModel entries and templates', () => {
  const refs = mc.literalRefs(`<Catalog>
    <CModel id="Rocks" parent="Doodad"><Model value="Assets\\Rocks\\Rocks.m3"/><VariationCount value="2"/></CModel>
    <CButton id="B"><Icon value="Assets\\Textures\\btn-b.dds"/></CButton>
    <CCommander id="C"><Image value="Assets\\Textures\\Logo_##id##.dds"/></CCommander>
  </Catalog>`);
  assert.deepEqual(refs, ['Assets\\Textures\\btn-b.dds']);
});

test('modelCheck finds missing models and textures across vanilla, Evo mods and maps', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modelcheck-'));
  const put = (rel, data = '') => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  // vanilla: a CascView extraction and SC2GameData templates
  put('casc/mods/liberty.sc2mod/base.sc2assets/assets/textures/vanilla.dds');
  put('gamedata/mods/core.sc2mod/base.sc2data/GameData/ModelData.xml',
    '<Catalog><CModel default="1" id="Unit"><?token id="Race" value="Neutral"?><Model value="Assets\\Units\\##Race##\\##id##\\##id##.m3"/></CModel></Catalog>');
  // dev repo: SCEvo_Core data, SCEvo_Assets art, one map with its own texture
  const evo = 'dev/SC Evo Complete';
  put(`${evo}/SCEvo_Core.SC2Mod/Base.SC2Data/GameData/Units.xml`, `<Catalog>
    <CModel id="Good" parent="Unit" Race="Terran"/>
    <CModel id="Gone" parent="Unit" Race="Terran"/>
    <CButton id="B"><Icon value="Assets\\Textures\\btn-missing.dds"/></CButton>
  </Catalog>`);
  put(`${evo}/SCEvo_Assets.SC2Mod/Base.SC2Assets/Assets/Units/Terran/Good/Good.m3`,
    fakeM3(['Assets/Textures/vanilla.dds', 'Assets/Textures/Good@Diff.dds', 'Assets/Textures/Lost.dds', 'Assets/Textures/Sub/Moved.dds']));
  put(`${evo}/SCEvo_Assets.SC2Mod/Base.SC2Assets/Assets/Textures/Good@Diff.dds`);
  put(`${evo}/SCEvo_Assets.SC2Mod/Base.SC2Assets/Assets/Textures/Moved.dds`);
  put(`${evo}/SCEvo_Assets.SC2Mod/Base.SC2Assets/Assets/Doodads/Crop/Crop.m3`, fakeM3(['F:\\Modding\\Assets\\Textures\\Moved.dds']));
  put(`${evo}/MP Maps/Test.SC2Map/Prop.m3`, fakeM3(['Assets/Textures/MapOnly.dds']));
  put(`${evo}/MP Maps/Test.SC2Map/Assets/Textures/MapOnly.dds`);

  const r = mc.modelCheck({ devRoot: path.join(tmp, 'dev'), cascRoot: path.join(tmp, 'casc'), gameDataPath: path.join(tmp, 'gamedata'), all: true });
  const got = r.problems.map((p) => [p.level, p.kind, p.ref.replace(/\\/g, '/'), p.byName, p.absolute]).sort();
  assert.deepEqual(got, [
    ['error', 'model', 'Assets/Units/Terran/Gone/Gone.m3', false, false],
    ['error', 'texture', 'Assets/Textures/Lost.dds', false, false],
    ['error', 'texture', 'F:/Modding/Assets/Textures/Moved.dds', false, true],
    ['warn', 'texture', 'Assets/Textures/Sub/Moved.dds', true, false],
    ['warn', 'texture', 'Assets/Textures/btn-missing.dds', false, false],
  ]);
  assert.equal(r.stats.containers, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});
