'use strict';
// Creates the first deploy-catalog.json from what's deployed today, so nothing
// changes for the campaign on the first run. Run once: `run.cmd init`.

const path = require('node:path');
const cfg = require('./config');
const catalog = require('./catalog');
const mf = require('./manifest');

const MODS = 'Mods\\SC Evolution Complete';
const CMODS = `${MODS}\\SCEvo_CampaignMods`;

// Mods and maps that live in the SC2 install but are never deployed.
const NEVER_DEPLOYED = [
  `${MODS}\\SCEvo_Extension.SC2Mod`, `${MODS}\\SCEvo_Extension_KR.SC2Mod`,
  `${MODS}\\SCEvo_LegacyExtension.SC2Mod`, `${MODS}\\SCEvo_LegacyExtension_KR.SC2Mod`,
  `${MODS}\\SCEvo_Glues.SC2Mod`, `${MODS}\\SCEvo_GluesAssets.SC2Mod`,
  `${MODS}\\SCEvo_MuliArtAssetsBackup.SC2Mod`, `${MODS}\\SCEvo_ObserverMod.SC2Mod`,
  `${CMODS}\\SCEvo_CampaignArmory.SC2Mod`, `${CMODS}\\SCEvo_CampaignGlues.SC2Mod`,
  `${CMODS}\\SCEvo_GluesAssets.SC2Mod`, `${CMODS}\\SCEvo_LegacyBuildingSizes.SC2Mod`,
  `${CMODS}\\upgradesComp.SC2Mod`,
  'Maps\\SCEvo\\LegacyLoomings\\10x10grid comp.SC2Map',
];

// The melee package's mods (SCEvo_Multi and what it and the SCEvo melee maps need).
const MELEE_MODS = [
  `${MODS}\\SCEvo_Multi.SC2Mod`, `${MODS}\\SC2_5015_Balance.SC2Mod`,
  `${MODS}\\SCEvo_MultiArtMod.SC2Mod`, `${MODS}\\SCEvo_MultiArtAssets.SC2Mod`,
];

// Known but not shipped yet: tracked as "off" so they don't show up as new.
const CAMPAIGN_OFF = [
  'Maps\\SCEvo\\LegacyRebelYell\\RebelStory.SC2Map',
  'Maps\\SCEvo\\LegacyRebelYell\\RebelYell1Legacy.SC2Map',
];

const sourceOf = (manifestPath) => manifestPath.replace(/\//g, '\\');

function moduleMeta(m, file) {
  const out = {};
  const base = path.basename(file.path, path.extname(file.path));
  if (m.id && m.id !== mf.moduleIdFor(path.basename(file.path))) out.id = m.id;
  if (m.name && m.name !== base) out.name = m.name;
  if (m.description && m.description !== (m.name || base)) out.description = m.description;
  if (m.type) out.type = m.type;
  return Object.keys(out).length ? out : undefined;
}

function seed() {
  const doc = catalog.emptyCatalog();
  const add = (source, patch) => catalog.upsert(doc, source, patch);

  const pub = mf.readManifest(cfg.PUBLIC_MANIFEST);
  const beta = mf.readManifest(cfg.BETA_MANIFEST);
  for (const m of (pub?.modules || [])) {
    for (const f of (m.files || [])) {
      const patch = { package: 'campaign', channel: 'public', module: moduleMeta(m, f) };
      if (Array.isArray(f.downloadUrls) && f.downloadUrls.length) patch.downloadUrls = f.downloadUrls;
      else if (f.downloadUrl) patch.downloadUrl = f.downloadUrl;
      add(sourceOf(f.path), patch);
    }
  }
  for (const m of (beta?.modules || [])) {
    for (const f of (m.files || [])) {
      const existing = catalog.findItem(doc, sourceOf(f.path));
      add(sourceOf(f.path), { package: 'campaign', channel: existing ? 'both' : 'beta', module: moduleMeta(m, f) });
    }
  }
  for (const s of MELEE_MODS) add(s, { package: 'melee', channel: 'public' });
  for (const s of CAMPAIGN_OFF) if (!catalog.findItem(doc, s)) add(s, { package: 'campaign', channel: 'off' });
  for (const s of NEVER_DEPLOYED) catalog.ignore(doc, s);
  return doc;
}

module.exports = { seed, NEVER_DEPLOYED, MELEE_MODS };
