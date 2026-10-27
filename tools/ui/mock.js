'use strict';
// A look-alike of the launcher (sc-evo-launcher 1.4: App.jsx, shell.jsx, theme.js), drawn
// from the manifest form so a deploy can be checked before it goes out. Nothing in it
// works: it is plain HTML, scoped under .lmock (mock.css). When the launcher's look
// changes, update this file to match.
//
//   LauncherMock.render(host, state)      the whole window (1024×720), scaled to fit host
//   LauncherMock.card(card, accent)       one news card, as in the news grid
//   LauncherMock.theme(accent)            the colours the launcher derives from one accent
//
// state: { channel: "public"|"beta", accent, otherAccent, betaShown, episode, background,
//          backgroundFallback, cards, announcement }
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

  // shell.jsx CampaignHero.
  // background: the channel's own image; fallback: where else to find it (the CDN copy).
  function hero(ep, background, fallback, beta) {
    if (!ep) return '<div class="lm-hero lm-hero-empty">No episode art (Settings → website path)</div>';
    const bg = background || siteImg(ep.background);
    const glow = siteImg(ep.glow);
    return `<div class="lm-hero">
      ${bg ? `<img class="lm-hero-bg" src="${esc(bg)}" alt=""${background && fallback ? ` onerror="if(this.dataset.f)return;this.dataset.f=1;this.src='${esc(fallback)}'"` : ''}>` : ''}
      <div class="lm-hero-shade"></div>
      ${ep.emblem ? `<div class="lm-emblem">
        ${glow ? `<div class="lm-glow" style="-webkit-mask-image:url('${esc(glow)}');mask-image:url('${esc(glow)}')"></div>` : ''}
        <img src="${esc(siteImg(ep.emblem))}" alt="">
        ${beta ? `<div class="lm-emblem-tape">${betaTape(14, 9)}</div>` : ''}</div>` : ''}
      ${ep.logo ? `<img class="lm-eplogo" src="${esc(siteImg(ep.logo))}" alt="">` : ''}
    </div>`;
  }

  function announcement(a) {
    if (!a?.enabled || !a.message) return '';
    const type = a.type || 'info';
    const tc = type === 'critical' ? '#ff4444' : type === 'warning' ? '#ffaa00' : '#00d4ff';
    const label = type === 'critical' ? 'Critical' : type === 'warning' ? 'Warning' : 'Info';
    return `<div class="lm-ann" style="--tc:${tc}"><div class="lm-ann-label">${label}</div>
      <div class="lm-ann-msg"><span>${esc(a.message)}</span></div><div class="lm-ann-x">✕</div></div>`;
  }

  // The whole window. Scaled into host with a CSS transform, so it keeps the launcher's proportions.
  function render(host, s) {
    const beta = s.channel === 'beta';
    const t = theme(s.accent || (beta ? '#ff6600' : SITE_ACCENT));
    const ac = t.accent;
    const pubAc = beta ? (hexOf(s.otherAccent) || SITE_ACCENT) : ac;
    const betaAc = beta ? ac : (hexOf(s.otherAccent) || '#ff6600');
    const seg = (on, col, label, icon) => `<div class="lm-seg${on ? ' on' : ''}" style="--sc:${col}">${icon || ''}${label}</div>`;
    const cards = (s.cards || []).filter((c) => !c.variant || c.variant === (beta ? 'beta' : 'public')).slice(0, 4);
    host.innerHTML = `<div class="lmock-frame"><div class="lmock" style="${t.vars}">
      <div class="lm-title" style="box-shadow:inset 0 -1px 0 ${ac}33,0 1px 12px ${ac}12">
        <img class="lm-brand" src="mock/logo-evo.webp" alt="">
        <div class="lm-tabs"><div class="lm-tab on">Campaign</div><div class="lm-tab">Melee</div></div>
        <div class="lm-title-right">
          ${s.betaShown || beta ? `<div class="lm-chan">${seg(!beta, pubAc, 'Public')}<span class="lm-sep"></span>${seg(beta, betaAc, 'Beta', beta ? '' : `<span class="lm-key">${I.key}</span>`)}</div>` : ''}
          <div class="lm-profile"><span class="lm-avatar" style="--av:${ac}"><span>${I.avatar}</span></span>
            <span class="lm-pname"><b>Anon-7F3A</b><small style="color:${ac}">Online player profile</small></span><span class="lm-gear">${I.gear}</span></div>
          <div class="lm-lang"><span class="lm-flag"></span><small>▼</small></div>
          <div class="lm-win">─</div><div class="lm-win">✕</div>
        </div>
      </div>
      ${announcement(s.announcement)}
      ${hero(s.episode, s.background, s.backgroundFallback, beta)}
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

  return { render, card, theme, siteImg, SITE_ACCENT };
})();
