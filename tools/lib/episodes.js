'use strict';
// The campaign episodes the website lists (<siteRepoPath>/assets/data/campaign.enUS.md,
// "# Episodes"), for choosing which one the launcher's campaign hero shows.
// The launcher bundles the same episodes' art (sc-evo-launcher: npm run sync:episodes).
// Each episode also carries its hero style from the site's EPISODE_STYLE
// (assets/js/campaign-page.js), which the launcher copies into src/episodes.js STYLE:
// the preview places the emblem and glow with it, as the launcher does.

const fs = require('node:fs');
const path = require('node:path');

const CAMPAIGN_REL = path.join('assets', 'data', 'campaign.enUS.md');
const STYLE_REL = path.join('assets', 'js', 'campaign-page.js');

// The site's (and the launcher's) defaults for an episode without its own tune.
const DEFAULT_TUNE = { emblemSize: 0.7, emblemY: -0.06, glowScale: 1.5, glowX: 0, glowY: 0 };

// { <episode>: { glowColor, emblemFilter, glowBreathe, tune } } from campaign-page.js source.
// The object holds regexes (postMatch), so it is read field by field rather than evaluated.
function parseEpisodeStyle(source) {
  const block = /var EPISODE_STYLE = \{([\s\S]*?)\n\s*\};/.exec(source || '');
  if (!block) return {};
  const out = {};
  for (const m of block[1].matchAll(/(?:^|[\s,{])(\d+):\s*\{([\s\S]*?)tune:\s*\{([^}]*)\}/g)) {
    const [, n, head, tuneText] = m;
    const tune = {};
    for (const t of tuneText.matchAll(/(\w+):\s*(-?\d*\.?\d+)/g)) tune[t[1]] = Number(t[2]);
    out[n] = {
      glowColor: /glowColor:\s*['"](#[0-9a-f]{3,8})['"]/i.exec(head)?.[1] || null,
      emblemFilter: /emblemFilter:\s*['"]([^'"]*)['"]/.exec(head)?.[1] || 'none',
      glowBreathe: /glowBreathe:\s*true/.test(head),
      tune: { ...DEFAULT_TUNE, ...tune },
    };
  }
  return out;
}

function readEpisodeStyle(siteRepoPath) {
  const file = siteRepoPath ? path.join(siteRepoPath, STYLE_REL) : null;
  try { return parseEpisodeStyle(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// [{ episode: 0, name: "Loomings", released: true, logo, emblem, glow, background,
//    glowColor, emblemFilter, glowBreathe, tune }, …]
// (images: site paths such as /assets/img/…); [] when the site isn't set up.
function readEpisodes(siteRepoPath) {
  const file = siteRepoPath ? path.join(siteRepoPath, CAMPAIGN_REL) : null;
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const section = /^# Episodes\n([\s\S]*?)(?=^# |$(?![\s\S]))/m.exec(text);
  if (!section) return [];
  const styles = readEpisodeStyle(siteRepoPath);
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
      const style = styles[n] || { glowColor: null, emblemFilter: 'none', glowBreathe: false, tune: { ...DEFAULT_TUNE } };
      out.push({ episode: n, name: title.trim(), released: /^true$/i.test(fields.released || ''),
        logo: fields.logo || null, emblem: fields.emblem || null, glow: fields.glow || null, background: fields.background || null,
        ...style });
    }
  }
  return out.sort((a, b) => a.episode - b.episode);
}

module.exports = { readEpisodes, parseEpisodeStyle, CAMPAIGN_REL, STYLE_REL, DEFAULT_TUNE };
