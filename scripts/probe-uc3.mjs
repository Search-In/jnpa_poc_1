#!/usr/bin/env node
/**
 * Probe the UC-3 shared backend: log in, then read the Shipping Line registry.
 *
 * Standalone diagnostic (Phase 1 connectivity proof) — confirms the /api proxy,
 * the credentials, the RBAC policy and the endpoint all work BEFORE any app code
 * is wired. Touches no application source; the same role `probe-aisstream.mjs`
 * plays for the AIS feed. No dependencies (Node 18+ global fetch).
 *
 * Usage:
 *   npm run dev                                  # in another terminal, then:
 *   node scripts/probe-uc3.mjs                   # through the Vite dev proxy
 *   node scripts/probe-uc3.mjs https://<host>/api   # straight to the gateway
 *
 * The default base goes through http://localhost:5173/api so the PROXY HOP is
 * exercised too — that is the hop Phase 1 adds. If it fails, re-run against the
 * gateway origin directly to tell a proxy fault from a backend fault.
 *
 * Credentials come from .env (VITE_UC3_USERNAME / VITE_UC3_PASSWORD) or real
 * environment variables — env vars win. Neither the password nor the full JWT is
 * ever printed.
 *
 * Exits 0 on success, 1 on failure. Note it sets `process.exitCode` and lets the
 * event loop drain rather than calling process.exit(): forcing exit while
 * undici's keep-alive sockets are still open trips a libuv teardown assertion on
 * Windows, which corrupts the exit code (observed: 127 on an otherwise clean run).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader — mirrors the one in publish-feature-layers.mjs (Node
 * doesn't auto-load .env for plain scripts, and we avoid adding a dependency).
 * Real environment variables take precedence.
 */
function loadDotEnv(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no .env file — rely on real env vars
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(join(ROOT, '.env'));

// Default through the dev server so the proxy is part of the test.
const BASE = (process.argv[2] || 'http://localhost:5173/api').replace(/\/+$/, '');
const USER = process.env.VITE_UC3_USERNAME || 'admin';
const PASS = process.env.VITE_UC3_PASSWORD || 'admin';

// Roles /api/shipping-lines accepts (gateway/auth.py: CONTROL_ROOM | CUSTOMS).
const ALLOWED_ROLES = ['JNPA_TRAFFIC', 'DTCCC_ADMIN', 'TERMINAL_OPS', 'CUSTOMS'];

const TARGET_HINT =
  'Checklist:\n' +
  '  • Is the gateway actually up, and does VITE_GATEWAY_URL point at it?\n' +
  '    Blank defaults to http://localhost:8000 — set it if the gateway is remote:\n' +
  '      VITE_GATEWAY_URL=https://<gateway-host>\n' +
  '  • Restart `npm run dev` after changing .env (Vite reads it at startup).\n' +
  '  • Bypass the proxy to isolate a proxy fault from a backend fault:\n' +
  '      node scripts/probe-uc3.mjs https://<gateway-host>/api';

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.error(`  ✗ ${m}`);

/** A probe step failed. Carries an optional operator-facing remediation hint. */
class ProbeError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

const fail = (msg, hint) => {
  throw new ProbeError(msg, hint);
};

/** Redact a JWT down to a recognisable, non-reusable prefix. */
function tokenPreview(t) {
  return typeof t === 'string' && t.length > 16 ? `${t.slice(0, 12)}…(${t.length} chars)` : '(none)';
}

/** Fetch + parse, returning {res, body} without throwing on a non-2xx or non-JSON body. */
async function call(path, init) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, init);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null; // non-JSON body (proxy error page, SPA fallback, empty)
  }
  return { res, body, url };
}

// ── 1. Reachability + auth posture ──────────────────────────────────────────
// /api/auth/roles is public (gateway/auth.py lists /api/auth in _PUBLIC), so it
// answers without a token and reveals whether AUTH_ENABLED is on. Doing this
// first turns "connection refused" into a clear diagnosis instead of a 401.
async function stepReachability() {
  console.log('1. GET /auth/roles  (public — reachability + auth posture)');
  let res, body;
  try {
    ({ res, body } = await call('/auth/roles'));
  } catch (e) {
    fail(`cannot reach ${BASE} — ${e.message}`,
      '  • Is the dev server running?  npm run dev\n' + TARGET_HINT);
  }
  if (!res.ok) {
    // A 5xx with a NON-JSON body is the Vite/nginx proxy reporting that it could
    // not reach its target — the proxy itself is wired, the gateway is not there.
    // Distinguishing this from a real gateway error is the whole point of step 1.
    if (res.status >= 500 && body === null) {
      fail(
        `HTTP ${res.status} from the proxy with a non-JSON body — the /api proxy is ` +
          'wired, but it cannot reach the gateway it forwards to.',
        TARGET_HINT,
      );
    }
    fail(`HTTP ${res.status} ${res.statusText} — ${JSON.stringify(body)}`,
      'The gateway answered but rejected /auth/roles, which is supposed to be public.');
  }
  if (body === null) {
    // A 200 that is not JSON means the SPA fallback served index.html — i.e. no
    // /api proxy matched the path at all.
    fail(
      'HTTP 200 but the body is not JSON — the dev server served the SPA instead of proxying.',
      'The /api proxy is not active. Restart `npm run dev` so vite.config.ts is reloaded.',
    );
  }
  ok(`reachable — auth_enabled=${body.auth_enabled}, roles=${(body.roles || []).length}`);
}

// ── 2. Login ────────────────────────────────────────────────────────────────
async function stepLogin() {
  console.log('\n2. POST /auth/login');
  const { res, body } = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) {
    fail(
      `HTTP ${res.status} ${res.statusText} — ${JSON.stringify(body)}`,
      'A 401 means the credentials are wrong. The gateway seeds admin/admin by\n' +
        'default, but AUTH_USERS="user:pass:ROLE,..." can override the whole table.',
    );
  }
  // The field is `access_token` (TokenResponse), NOT `token` — a common mis-read.
  const token = body?.access_token;
  if (!token) {
    fail(`no access_token in response — got keys: ${Object.keys(body || {}).join(', ')}`);
  }
  ok(`access_token=${tokenPreview(token)}`);
  ok(`role=${body.role}  token_type=${body.token_type}  auth_enabled=${body.auth_enabled}`);
  if (!ALLOWED_ROLES.includes(body.role)) {
    bad(`role ${body.role} is NOT permitted on /api/shipping-lines ` +
      `(needs one of ${ALLOWED_ROLES.join(', ')})`);
  } else {
    ok('role is permitted on /api/shipping-lines');
  }
  return token;
}

// ── 3. The actual resource ──────────────────────────────────────────────────
async function stepShippingLines(token) {
  console.log('\n3. GET /shipping-lines/lines?limit=5&offset=0  (with bearer)');
  const { res, body } = await call('/shipping-lines/lines?limit=5&offset=0', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    fail(
      `HTTP ${res.status} ${res.statusText} — ${JSON.stringify(body)}`,
      res.status === 404
        ? 'A 404 here usually means the path was doubled (/api/api/...). Check that\n' +
          'BASE already ends in /api and the suffix does not repeat it.'
        : 'A 403 means the token role is not in CONTROL_ROOM | CUSTOMS.',
    );
  }
  const items = body?.items ?? [];
  ok(`HTTP 200 — total=${body?.total}  count=${body?.count}  ` +
    `X-Total-Count=${res.headers.get('x-total-count')}`);

  if (items.length === 0) {
    console.log('\n  ⚠ The endpoint works but returned ZERO rows.');
    console.log('    The tables are created at gateway boot, so their existence does not');
    console.log('    imply an import ran. Verify with:');
    console.log('      SELECT count(*) FROM jnpa.shipping_lines;');
    return;
  }

  console.log('\n  line_code   line_name   container_count   last_seen');
  console.log('  ' + '─'.repeat(62));
  for (const r of items) {
    const code = String(r.line_code ?? '').padEnd(11);
    const name = String(r.line_name ?? '(null)').padEnd(11);
    const cnt = String(r.container_count ?? '').padEnd(17);
    console.log(`  ${code}${name}${cnt}${r.last_seen ?? ''}`);
  }
  // line_name is never populated by the importer (it upserts line_code only),
  // so a null here is expected source-data behaviour, not a fault.
  if (items.every((r) => r.line_name === null)) {
    console.log('\n  Note: every line_name is null — expected. The importer upserts');
    console.log('  line_code only, so the UI must fall back to the code.');
  }
}

// ── 4. Unauthenticated control ──────────────────────────────────────────────
// Tells us whether the bearer is actually load-bearing or the gateway is running
// open (AUTH_ENABLED=false) — which changes nothing for Phase 1 but matters later.
async function stepEnforcement() {
  console.log('\n4. GET /shipping-lines/lines  (no bearer — enforcement check)');
  const { res } = await call('/shipping-lines/lines?limit=1');
  if (res.status === 401 || res.status === 403) {
    ok(`HTTP ${res.status} — auth is ENFORCED; the bearer is required`);
  } else if (res.ok) {
    ok('HTTP 200 — gateway is running OPEN (AUTH_ENABLED=false); the bearer is ignored');
  } else {
    bad(`unexpected HTTP ${res.status} ${res.statusText}`);
  }
}

async function main() {
  console.log(`Probing UC-3 backend at ${BASE}`);
  console.log(`  user=${USER}  password=${'*'.repeat(PASS.length)}\n`);
  await stepReachability();
  const token = await stepLogin();
  await stepShippingLines(token);
  await stepEnforcement();
}

try {
  await main();
  console.log(`\n=== RESULT: PASSED — login + shipping-lines reachable via ${BASE} ===`);
  process.exitCode = 0;
} catch (err) {
  if (err instanceof ProbeError) {
    bad(err.message);
    if (err.hint) console.error(`\n${err.hint}`);
  } else {
    bad(`unexpected error — ${err?.stack || err}`);
  }
  console.error('\n=== RESULT: FAILED ===');
  process.exitCode = 1;
}
