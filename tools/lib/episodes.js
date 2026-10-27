'use strict';
// The campaign episodes the website lists (<siteRepoPath>/assets/data/campaign.enUS.md,
// "# Episodes"), for choosing which one the launcher's campaign hero shows.
// The launcher bundles the same episodes' art (sc-evo-launcher: npm run sync:episodes).

const fs = require('node:fs');
const path = require('node:path');

const CAMPAIGN_REL = path.join('assets', 'data', 'campaign.enUS.md');

// [{ episode: 0, name: "Loomings", released: true, logo, emblem, glow, background }, …]
// (images: site paths such as /assets/img/…); [] when the site isn't set up.
function readEpisodes(siteRepoPath) {
  const file = siteRepoPath ? path.join(siteRepoPath, CAMPAIGN_REL) : null;
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const section = /^# Episodes\n([\s\S]*?)(?=^# |$(?![\s\S]))/m.exec(text);
  if (!section) return [];
  const out = [];
  for (const block of section[1].split(/^## /m).slice(1)) {
    const [title, ...lines] = block.split('\n');
    const fields = {};
    for (const l of lines) {
      if (!l.trim()) break;
      const m = /^([\w-]+):\s*(.*)$/.exec(l);
      if (m) fields[m[1]] = m[2].trim();
    }
    const n = Number(fields.episode);
    if (fields.episode !== undefined && Number.isInteger(n)) {
      out.push({ episode: n, name: title.trim(), released: /^true$/i.test(fields.released || ''),
        logo: fields.logo || null, emblem: fields.emblem || null, glow: fields.glow || null, background: fields.background || null });
    }
  }
  return out.sort((a, b) => a.episode - b.episode);
}

module.exports = { readEpisodes, CAMPAIGN_REL };
