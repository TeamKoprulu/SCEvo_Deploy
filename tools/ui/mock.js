'use strict';
// A look-alike of the launcher (sc-evo-launcher 1.4: App.jsx, shell.jsx, theme.js), drawn
// from the manifest form so a deploy can be checked before it goes out. Nothing in it
// works: it is plain HTML, scoped under .lmock (mock.css). When the launcher's look
// changes, update this file to match.
//
//   LauncherMock.render(host, state)      the whole window (1024×720), scaled to fit host
//   LauncherMock.renderMelee(host, state) the Melee vs AI tab's lobby for one map (public or melee beta)
//   LauncherMock.heroStrip(host, state)   the campaign hero alone at state.width (the hero editor)
//   LauncherMock.card(card, accent)       one news card, as in the news grid
//   LauncherMock.theme(accent)            the colours the launcher derives from one accent
//
// state: { channel: "public"|"beta", accent, otherAccent, betaShown, episode, background,
//          backgroundFallback, hero, cards, announcement }
//   episode: { name, logo, emblem, glow, background } (site paths); background: the channel's
//   image URL (blank = the episode's), tried at backgroundFallback when it fails to load.

window.LauncherMock = (() => {
  const SITE_ACCENT = '#54b893';
  const PATREON = '#ff424d';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hexOf = (v) => {
    let h = String(v || '').trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/.test(h) ? '#' + h : null;
  };
  // Site paths (/assets/img/…) are served from the website repo by the deploy server.
  const siteImg = (p) => (!p ? null : /^(https?:|data:|\/site-asset\/|\/launcher-bg\/)/.test(p) ? p : '/site-asset' + (p.startsWith('/') ? p : '/' + p));

  // theme.js themeFromAccent + cssVars.
  function theme(accent) {
    const hex = hexOf(accent) || SITE_ACCENT;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const tint = (base, t) => rgb.map((c) => Math.round(base + (c - base) * t));
    const surfaces = {
      bg: tint(5, 0.03), panel: tint(11, 0.055), panel2: tint(14, 0.075),
      line: tint(26, 0.1), line2: tint(38, 0.14), dim2: tint(60, 0.16), dim: tint(92, 0.35),
    };
    const vars = Object.entries(surfaces).map(([k, v]) => `--${k}:rgb(${v.join(',')});--${k}-rgb:${v.join(',')}`).join(';');
    return { accent: hex, surfaces, vars: `${vars};--ac:${hex}` };
  }

  const I = {
    play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
    ext: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
    key: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></svg>',
    avatar: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="7" r="4"/><path d="M2 20c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5z"/></svg>',
  };

  // shell.jsx BetaTape.
  const betaTape = (size, angle) =>
    `<div class="lm-tape" style="--ts:${size}px;transform:rotate(${angle}deg)"><i></i><span>BETA</span><i></i></div>`;

  // App.jsx NewsImage.
  function newsImage(c, ac, badge) {
    const badgeHtml = badge ? `<div class="lm-badge" style="background:${esc(c.badgeColor || ac)}">${esc(badge)}</div>` : '';
    if (c.imageUrl) return `<div class="lm-nimg"><img src="${esc(c.imageUrl)}" alt=""><div class="lm-scan"></div>${badgeHtml}</div>`;
    const a = c.imageAccent || ac;
    return `<div class="lm-nimg lm-ntext" style="background:${esc(c.imageBg || '#0a2a1a')};--na:${esc(a)}">
      <div class="lm-ngrid"></div><div class="lm-nglow"></div><div class="lm-scan"></div>
      <div class="lm-nwords"><div class="lm-nsc">StarCraft</div><div class="lm-nevo">Evolution Complete</div>
        <div class="lm-nbox">${esc(`${c.imageText || 'EVO UPDATE'} ${c.imageLabel || ''}`.trim())}</div></div>${badgeHtml}</div>`;
  }

  const isPatreon = (c) => !!c.patreonId || /patreon\.com/i.test(c.linkUrl || '');

  // App.jsx renderNewsCard (banner, promo, Patreon and plain cards).
  function card(c, accent) {
    const ac = hexOf(accent) || SITE_ACCENT;
    if (!c) return '';
    if (c.type === 'banner') return `<div class="lm-card lm-banner"><img src="${esc(c.imageUrl)}" alt=""></div>`;
    if (c.type === 'promo') {
      const pa = c.labelColor || c.badgeColor || '#ffaa00';
      return `<div class="lm-card lm-promo" style="--pa:${esc(pa)}">
        <div class="lm-cimg lm-promo-img">${newsImage(c, ac, c.badge)}<div class="lm-promo-label">${esc(c.label || 'FEATURED')}</div></div>
        <div class="lm-cbody"><div class="lm-ptitle">${esc(c.title)}</div><div class="lm-cexcerpt">${esc(c.excerpt)}</div>
          ${c.linkUrl ? `<div class="lm-more">WATCH NOW ${I.ext}</div>` : ''}</div></div>`;
    }
    const pat = isPatreon(c);
    const cAc = pat ? PATREON : ac;
    const byline = c.date || c.author ? `<div class="lm-byline" style="color:${cAc}66">
        ${c.date ? `<span>${esc(c.date)}</span>` : ''}${c.date && c.author ? '<span style="opacity:.6">·</span>' : ''}
        ${c.author ? `<span class="lm-who" style="color:${cAc}99">${c.authorIcon ? `<img src="${esc(c.authorIcon)}" alt="" style="border-color:${cAc}33" onerror="this.remove()">` : ''}${esc(c.author)}</span>` : ''}</div>` : '';
    const body = c.type === 'patchnotes' && Array.isArray(c.highlights)
      ? `<ul class="lm-cexcerpt">${c.highlights.map((h) => `<li>${esc(String(h).replace(/^\s*[-•*·]\s*/, ''))}</li>`).join('')}</ul>`
      : `<div class="lm-cexcerpt">${esc(c.excerpt)}</div>`;
    return `<div class="lm-card${pat ? ' lm-patreon' : ''}">
      <div class="lm-cimg">${newsImage(c, ac, pat ? null : c.badge)}
        ${pat ? `<div class="lm-pattag"><img src="mock/patreon-logo.svg" alt="">Patreon</div>` : ''}</div>
      <div class="lm-cbody"><div class="lm-ctitle"${pat ? ` style="color:${PATREON}"` : ''}>${esc(c.title)}</div>${byline}${body}
        ${c.linkUrl ? `<div class="lm-more" style="color:${cAc}">${esc(c.readMoreLabel || 'Read more')} ${I.ext}</div>` : ''}</div></div>`;
  }

  // shell.jsx CampaignHero: a 1.95:1 stage (140px tall, 6px off the hero's bottom) with the logo
  // across its bottom and the emblem above it, placed by the episode's tune (site EPISODE_STYLE,
  // lib/episodes.js): emblemSize / emblemY in stage heights, glowScale / glowX / glowY in emblem sizes.
  // The glow is the episode's glowColor (else the channel accent), masked by the glow image.
  // background: the channel's own image; fallback: where else to find it (the CDN copy).
  // h: the channel's "hero" section (the hero editor's; launcher src/heroLayout.mjs rules): logo,
  // emblem and video placed in launcher px (x from the hero's centre, y from its top, scale), with
  // media URLs already pointing where the preview can load them. Unplaced pieces keep the stage.
  const HERO_H = 172, STAGE_H = 140, STAGE_W = STAGE_H * 1.95;
  const DEFAULT_TUNE = { emblemSize: 0.7, emblemY: -0.06, glowScale: 1.5, glowX: 0, glowY: 0 };
  const fin = (v) => Number.isFinite(v);
  const clampN = (v, lo, hi, d) => (fin(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const placeOf = (p) => (p && ['x', 'y', 'scale'].some((k) => fin(p[k]))
    ? { x: clampN(p.x, -4000, 4000, 0), y: clampN(p.y, -HERO_H, 2 * HERO_H, HERO_H / 2), scale: clampN(p.scale, 0.1, 4, 1) } : null);
  function heroLayout(h) {
    if (!h) return { logo: null, emblem: null, video: null, hideEmblem: false };
    const hideEmblem = h.emblem?.show === false;
    const below = h.video?.vignette === 'below';
    const video = h.video && (h.video.src || h.video.poster)
      ? { ...(placeOf(h.video) || { x: 0, y: HERO_H / 2, scale: 1 }), layer: h.video.layer === 'front' && !below ? 'front' : 'behind',
          vignette: below ? 'below' : 'above', src: h.video.src || null, poster: h.video.poster || null }
      : null;
    return { logo: placeOf(h.logo), emblem: hideEmblem ? null : placeOf(h.emblem), video, hideEmblem };
  }
  const at = (p) => `left:calc(50% + ${p.x}px);top:${p.y}px;transform:translate(-50%,-50%);`;

  function hero(ep, background, fallback, beta, accent, h) {
    if (!ep) return '<div class="lm-hero lm-hero-empty">No episode art (Settings → website path)</div>';
    const bg = background || siteImg(ep.background);
    const glow = siteImg(ep.glow);
    const tune = { ...DEFAULT_TUNE, ...(ep.tune || {}) };
    const L = heroLayout(h);
    const g = (hexOf(ep.glowColor) || hexOf(accent) || SITE_ACCENT);
    const rgb = [1, 3, 5].map((i) => parseInt(g.slice(i, i + 2), 16));
    const rgba = (a) => `rgba(${rgb.join(',')},${a})`;
    const white = (t) => `rgb(${rgb.map((c) => Math.round(c * t + 255 * (1 - t))).join(',')})`;
    const box = `width:${100 * tune.glowScale}%;height:${100 * tune.glowScale}%;`
      + `left:${50 - 50 * tune.glowScale + 100 * tune.glowX}%;top:${50 - 50 * tune.glowScale + 100 * tune.glowY}%;`
      + (glow ? `-webkit-mask-image:url('${esc(glow)}');mask-image:url('${esc(glow)}');` : '');
    const size = STAGE_H * tune.emblemSize;
    const filter = ep.emblemFilter && ep.emblemFilter !== 'none' ? `${ep.emblemFilter} ` : '';
    const emblem = (style) => (ep.emblem && !L.hideEmblem ? `<div class="lm-emblem" data-part="emblem" style="${style}">
          ${glow ? `<div class="lm-glow${ep.glowBreathe ? ' lm-breathe' : ''}" style="${box}background:radial-gradient(circle at 50% 50%,${white(0.85)} 0%,${rgba(1)} 45%,${rgba(0.55)} 100%)"></div>
            <div class="lm-glow lm-scan-lines" style="${box}background:linear-gradient(180deg,transparent 0%,${rgba(0.6)} 50%,transparent 100%) 0 -60% / 100% 35% no-repeat,repeating-linear-gradient(0deg,${rgba(0.45)} 0 1px,transparent 1px 4px)"></div>` : ''}
          <img src="${esc(siteImg(ep.emblem))}" alt="" style="filter:${esc(filter)}drop-shadow(0 14px 26px rgba(0,0,0,0.75))">
          ${beta ? `<div class="lm-emblem-tape">${betaTape(14, 9)}</div>` : ''}</div>` : '');
    const logo = (style) => (ep.logo ? `<div class="lm-eplogo" data-part="logo" style="${style}"><img src="${esc(siteImg(ep.logo))}" alt=""></div>` : '');
    const v = L.video;
    const media = v ? `<div class="lm-hvideo" data-part="video" style="${at(v)}height:${HERO_H * v.scale}px;z-index:${v.vignette === 'below' ? 0 : v.layer === 'front' ? 3 : 1}">
        ${v.poster ? `<img src="${esc(v.poster)}" alt="">` : ''}
        ${v.src ? `<video src="${esc(v.src)}" autoplay muted loop playsinline${v.poster ? ' class="over"' : ''}></video>` : ''}</div>` : '';
    return `<div class="lm-hero">
      ${bg ? `<img class="lm-hero-bg" src="${esc(bg)}" alt=""${background && fallback ? ` onerror="if(this.dataset.f)return;this.dataset.f=1;this.src='${esc(fallback)}'"` : ''}>` : ''}
      ${v?.vignette === 'below' ? media : ''}
      <div class="lm-hero-shade"></div>
      ${v?.vignette !== 'below' ? media : ''}
      ${!L.emblem || !L.logo ? `<div class="lm-stage">
        ${!L.emblem ? emblem(`left:0;right:0;margin:0 auto;top:${STAGE_H * tune.emblemY}px;width:${size}px;height:${size}px`) : ''}
        ${!L.logo ? logo('left:0;bottom:0;width:100%') : ''}
      </div>` : ''}
      ${L.emblem ? emblem(`${at(L.emblem)}width:${size * L.emblem.scale}px;height:${size * L.emblem.scale}px;z-index:2`) : ''}
      ${L.logo ? logo(`${at(L.logo)}width:${STAGE_W * L.logo.scale}px;z-index:2`) : ''}
    </div>`;
  }

  // The hero alone at a window width (the editor's stage), scaled to the host's width. Its pieces
  // carry data-part="logo|emblem|video" and take pointer events, for dragging.
  function heroStrip(host, s) {
    const beta = s.channel === 'beta';
    const t = theme(s.accent || (beta ? '#ff6600' : SITE_ACCENT));
    const w = Math.max(900, Number(s.width) || 1024);
    const k = Math.min(1, host.clientWidth / w) || 1;
    host.innerHTML = `<div class="lm-strip-frame" style="width:${w * k}px;height:${HERO_H * k}px">
      <div class="lmock lm-strip" style="${t.vars};width:${w}px;height:${HERO_H}px;transform:scale(${k})">
        ${hero(s.episode, s.background, s.backgroundFallback, beta, t.accent, s.hero)}</div></div>`;
    return { k, width: w };
  }

  function announcement(a) {
    if (!a?.enabled || !a.message) return '';
    const type = a.type || 'info';
    const tc = type === 'critical' ? '#ff4444' : type === 'warning' ? '#ffaa00' : '#00d4ff';
    const label = type === 'critical' ? 'Critical' : type === 'warning' ? 'Warning' : 'Info';
    return `<div class="lm-ann" style="--tc:${tc}"><div class="lm-ann-label">${label}</div>
      <div class="lm-ann-msg"><span>${esc(a.message)}</span></div><div class="lm-ann-x">✕</div></div>`;
  }

  // App.jsx title bar. tab: which main tab is on; the Public/Beta switch shows while that tab's beta is on.
  function titleBar(s, ac, tab) {
    const beta = s.channel === 'beta';
    const pubAc = beta ? (hexOf(s.otherAccent) || SITE_ACCENT) : ac;
    const betaAc = beta ? ac : (hexOf(s.otherAccent) || '#ff6600');
    const seg = (on, col, label, icon) => `<div class="lm-seg${on ? ' on' : ''}" style="--sc:${col}">${icon || ''}${label}</div>`;
    return `<div class="lm-title" style="box-shadow:inset 0 -1px 0 ${ac}33,0 1px 12px ${ac}12">
        <img class="lm-brand" src="mock/logo-evo.webp" alt="">
        <div class="lm-tabs"><div class="lm-tab${tab === 'campaign' ? ' on' : ''}">Campaign</div><div class="lm-tab${tab === 'melee' ? ' on' : ''}">Melee vs AI</div></div>
        <div class="lm-title-right">
          ${s.betaShown || beta ? `<div class="lm-chan">${seg(!beta, pubAc, 'Public')}<span class="lm-sep"></span>${seg(beta, betaAc, 'Beta', beta ? '' : `<span class="lm-key">${I.key}</span>`)}</div>` : ''}
          <div class="lm-profile"><span class="lm-avatar" style="--av:${ac}"><span>${I.avatar}</span></span>
            <span class="lm-pname"><b>Anon-7F3A</b><small style="color:${ac}">Online player profile</small></span><span class="lm-gear">${I.gear}</span></div>
          <div class="lm-lang"><span class="lm-flag"></span><small>▼</small></div>
          <div class="lm-win">─</div><div class="lm-win">✕</div>
        </div>
      </div>`;
  }

  // The whole window. Scaled into host with a CSS transform, so it keeps the launcher's proportions.
  function render(host, s) {
    const beta = s.channel === 'beta';
    const t = theme(s.accent || (beta ? '#ff6600' : SITE_ACCENT));
    const ac = t.accent;
    const cards = (s.cards || []).filter((c) => !c.variant || c.variant === (beta ? 'beta' : 'public')).slice(0, 4);
    host.innerHTML = `<div class="lmock-frame"><div class="lmock" style="${t.vars}">
      ${titleBar(s, ac, 'campaign')}
      ${announcement(s.announcement)}
      ${hero(s.episode, s.background, s.backgroundFallback, beta, ac, s.hero)}
      <div class="lm-news">
        <div class="lm-eyebrow"><span></span>Latest news</div>
        <div class="lm-grid">${cards.length ? cards.map((c) => card(c, ac)).join('') : '<div class="lm-nonews">No news cards for this channel.</div>'}</div>
      </div>
      <div class="lm-bottom">
        <div class="lm-files" style="border-color:${ac}44"><span style="color:${ac}">${I.check}</span>All 12 files up to date<small>›</small></div>
        <div style="flex:1"></div>
        <div class="lm-status"><i style="background:${ac};box-shadow:0 0 8px ${ac}"></i>Ready to play</div>
        <div class="lm-play" style="background:${ac};filter:drop-shadow(0 0 14px ${ac}22)"><div class="lm-shimmer"></div><span>${I.play}Play</span></div>
      </div>
    </div></div>`;
    fit(host);
  }

  // ── Melee vs AI lobby (melee/MeleeTab.jsx + LobbySetup.jsx), as it opens on a map: you and one
  // Elite AI, random colours and decals. state: { channel, accent, otherAccent, betaShown, balance, map }
  //   map: { name, description, modes, players, size: { w, h }, tileset, thumb } (thumb: an image URL).
  const RACE = { BWTe: 'Terran · Brood War', BWPr: 'Protoss · Brood War' };
  const RANDOM_SWATCH = 'repeating-linear-gradient(45deg,#f40404 0 5px,#0b48cc 5px 10px,#2cb494 10px 15px,#ebe129 15px 20px)';
  // ui.jsx prettyTileset / mapDetails.
  const prettyTileset = (ts) => String(ts || '').replace(/^Evo_/i, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const mapDetails = (m) => [m.players ? `${m.players} players` : null, m.size ? `${m.size.w}×${m.size.h}` : null, m.tileset ? prettyTileset(m.tileset) : null].filter(Boolean).join(' · ');
  // lobbyModel.mjs availableModes: team modes that fit, then FFA and "You vs allied AIs" from 3 players.
  const modesFor = (n) => [['1v1', 2], ['2v2', 4], ['3v3', 6], ['4v4', 8]].filter(([, k]) => k <= n).map(([id]) => id)
    .concat(n >= 3 ? ['Free for all', 'You vs allied AIs'] : []);
  const segmented = (opts, on, ac, small) => `<div class="lm-mseg${small ? ' sm' : ''}">${opts.map((o, i) =>
    `<div class="lm-mseg-o${i === on ? ' on' : ''}" style="--a:${ac}">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>`).join('')}</div>`;

  function playerCard(p, ac) {
    return `<div class="lm-pcard${p.user ? ' me' : ''}" style="--a:${ac}">
      <i class="lm-pstripe"></i>
      <div class="lm-prace"><img src="mock/race-${p.race}.png" alt=""><small>▾</small></div>
      <div class="lm-pinfo"><b>${esc(p.name)}</b>${p.user ? `<span>${esc(RACE[p.race])}</span>` : '<div class="lm-pdd">Elite<small>▼</small></div>'}</div>
      <div class="lm-pdecal">?<small>▾</small></div>
      <div class="lm-pcolor" style="background:${RANDOM_SWATCH}">?</div>
    </div>`;
  }

  function renderMelee(host, s) {
    const beta = s.channel === 'beta';
    const t = theme(s.accent || (beta ? '#ff6600' : SITE_ACCENT));
    const ac = t.accent;
    const m = s.map;
    const left = m ? `<div class="lm-mthumb">${m.thumb ? `<img src="${esc(m.thumb)}" alt="">` : `<span>${m.players ? `${m.players}P` : '?'}</span>`}</div>
        <div class="lm-mname">${esc(m.name)}</div>
        <div class="lm-mdetails" style="color:${ac}">${esc(mapDetails(m))}</div>
        ${m.modes ? `<div class="lm-label">Suggested: ${esc(m.modes)}</div>` : ''}
        <div class="lm-mdesc">${esc(m.description || '')}</div>
        <div class="lm-ghost" style="--a:${ac}">◀ Change map</div>`
      : '<div class="lm-mdesc">No maps in the melee pool yet.</div>';
    host.innerHTML = `<div class="lmock-frame"><div class="lmock" style="${t.vars}">
      ${titleBar(s, ac, 'melee')}
      <div class="lm-melee">
        <div class="lm-lobby">
          <div class="lm-mpanel">${left}</div>
          <div class="lm-lright">
            <div class="lm-lrow"><div class="lm-label lm-lw">Balance</div>${segmented([{ label: 'Evo', sub: 'BW vs SC2 races' }, { label: 'Legacy', sub: 'Brood War races only' }], s.balance === 'legacy' ? 1 : 0, ac)}</div>
            <div class="lm-lrow"><div class="lm-label lm-lw">Mode</div>${segmented(modesFor(m?.players || 2).map((label) => ({ label })), 0, ac, true)}</div>
            <div class="lm-teams">
              <div class="lm-team"><div class="lm-thead" style="--a:${ac}">Team 1</div>${playerCard({ user: true, name: 'You', race: 'BWTe' }, ac)}</div>
              <div class="lm-vs" style="--a:${ac}"><i></i><b>VS</b><i></i></div>
              <div class="lm-team"><div class="lm-thead" style="--a:${ac}">Team 2</div>${playerCard({ name: 'Computer 1', race: 'BWPr' }, ac)}</div>
            </div>
            <div class="lm-lfoot">
              <div class="lm-ghost" style="--a:${ac}">Set all AIs ▲</div>
              <span class="lm-check"><i></i>Windowed</span>
              <span class="lm-speed">Game speed<span class="lm-slider" style="--a:${ac}"><i></i><i></i><i></i><i></i><i></i><b></b></span></span>
            </div>
          </div>
        </div>
        <div class="lm-mbottom">
          <div class="lm-play" style="background:${ac};filter:drop-shadow(0 0 14px ${ac}22)"><div class="lm-shimmer"></div><span>${I.play}Start</span></div>
        </div>
      </div>
    </div></div>`;
    fit(host);
  }

  // Scale the 1024×720 window to the host's width.
  const observed = new WeakSet();
  function fit(host) {
    const frame = host.querySelector('.lmock-frame');
    if (!frame) return;
    const k = Math.min(1, host.clientWidth / 1024) || 1;
    frame.style.setProperty('--k', k);
    frame.style.height = `${720 * k}px`;
    frame.style.width = `${1024 * k}px`;
    if (!observed.has(host) && 'ResizeObserver' in window) {
      observed.add(host);
      new ResizeObserver(() => fit(host)).observe(host);
    }
  }

  return { render, renderMelee, heroStrip, card, theme, siteImg, SITE_ACCENT, HERO_H, STAGE_W };
})();
