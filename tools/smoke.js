'use strict';
// Browser-accurate load test for the deploy tool.  Run: node tools/smoke.js
//
// Boots the real server, then loads the page the way a browser does — and that
// distinction is the whole point. Fetching "/app.css?t=<TOKEN>" by hand passes
// even when the tool is completely broken; a browser resolves the relative
// <link href="app.css"> to "/app.css" with NO query string and no x-token
// header. That gap shipped a UI that rendered as bare unstyled HTML.
//
// Also asserts the API still 403s without a token, so "fix the 403s" can never
// quietly become "remove the auth".

const path = require('node:path');
const { spawn } = require('node:child_process');

const APP = path.join(__dirname, 'app.js');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// Starts the server on an ephemeral port and waits for it to print its URL.
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [APP, '--no-open'], {
      env: { ...process.env, SCEVO_PORT: '0' },
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start within 15s')); }, 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${m[1]}`, token: m[2], port: m[1] });
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})\n${out}`)); });
  });
}

// Every href/src the document asks the browser to go and fetch.
function subresources(html) {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:)/i.test(u));
}

(async () => {
  console.log('\n  SCEvo Deploy — smoke test\n');
  const { child, base, token, port } = await startServer();

  try {
    // 1. The document itself, exactly as the address bar requests it.
    const docRes = await fetch(`${base}/?t=${token}`);
    const html = await docRes.text();
    check('GET /?t=<token> serves the document',
      docRes.ok && (docRes.headers.get('content-type') || '').includes('text/html'),
      `${docRes.status} ${docRes.headers.get('content-type')}`);

    // 2. The browser stores the cookie handed back with the document.
    const setCookie = docRes.headers.get('set-cookie') || '';
    const jar = setCookie.split(';')[0];
    check('document hands back a session cookie',
      new RegExp(`^scevo_${port}=${token}$`).test(jar),
      jar || '(no Set-Cookie)');

    // 3. Each subresource, resolved relative to the page: no query string, no
    //    x-token header, only the cookie. This is the check that matters.
    const assets = subresources(html);
    check('document references subresources', assets.length > 0, assets.join(', '));

    for (const asset of assets) {
      const url = new URL(asset, `${base}/`).href;
      const res = await fetch(url, { headers: jar ? { cookie: jar } : {} });
      const type = res.headers.get('content-type') || '';
      const body = await res.text();
      check(`GET ${new URL(url).pathname} (as a browser asks for it)`,
        res.ok && body.length > 0 && !type.includes('application/json'),
        `${res.status} ${type} ${body.length}B`);
    }

    // 4. Auth still works, and still bites.
    const withToken = await fetch(`${base}/api/state?t=${token}`);
    check('GET /api/state with token', withToken.ok, String(withToken.status));

    const noToken = await fetch(`${base}/api/state`);
    check('GET /api/state without any token is refused', noToken.status === 403, String(noToken.status));

    const cookieOnly = await fetch(`${base}/api/state`, { headers: jar ? { cookie: jar } : {} });
    check('GET /api/state with cookie only', cookieOnly.ok, String(cookieOnly.status));

    const badToken = await fetch(`${base}/api/state?t=deadbeef`);
    check('GET /api/state with a wrong token is refused', badToken.status === 403, String(badToken.status));
  } finally {
    child.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(`\n  smoke test could not run: ${err.message}\n`);
  process.exit(1);
});
