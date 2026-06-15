#!/usr/bin/env node
/**
 * publish-feature-layers.mjs — publish the seed CSVs in ./seed as Hosted
 * Feature Layers in your ArcGIS Online / Enterprise org.
 *
 * It uses the ArcGIS REST "generateToken → addItem (CSV) → publish" flow, the
 * same one the ArcGIS Online UI performs when you drag a CSV in. No SDK needed —
 * just Node 18+ (global fetch / FormData / Blob).
 *
 * Credentials come from `.env` (ARCGIS_USER / ARCGIS_PASS / optional
 * ARCGIS_PORTAL) or real environment variables — env vars win over the file.
 *
 * Usage:
 *   node scripts/publish-feature-layers.mjs        # reads .env
 *   ARCGIS_USER=you ARCGIS_PASS=secret node scripts/publish-feature-layers.mjs
 *
 * After it runs, copy the printed service URLs into your .env as
 *   VITE_FS_BERTHS_URL, VITE_FS_BERTHING_PLAN_URL, VITE_FS_PORT_CRAFT_URL,
 *   VITE_FS_KPI_SNAPSHOTS_URL, VITE_FS_VESSELS_URL
 * and set VITE_DATA_MODE=live.
 *
 * NOTE: For production, prefer publishing the live Vessels layer via ArcGIS
 * Velocity (Stream + spatiotemporal layers). These CSV layers seed the static
 * reference + history layers and give a repeatable demo.
 */

import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader (Node doesn't auto-load .env for plain scripts, and we
 * avoid adding a dependency). Real environment variables take precedence.
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
    // strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(join(ROOT, '.env'));

const PORTAL = process.env.ARCGIS_PORTAL ?? 'https://www.arcgis.com';
const USER = process.env.ARCGIS_USER;
const PASS = process.env.ARCGIS_PASS;
const SEED_DIR = join(ROOT, 'seed');

// CSV → (title, the field publish should treat as the layer's date/location).
const LAYERS = [
  { file: 'berths.csv', title: 'JNPA_Berths', locationType: 'coordinates', latField: 'LAT', lonField: 'LON' },
  { file: 'vessels.csv', title: 'JNPA_Vessels', locationType: 'coordinates', latField: 'LAT', lonField: 'LON' },
  { file: 'port_craft.csv', title: 'JNPA_PortCraft', locationType: 'none' },
  { file: 'berthing_plan.csv', title: 'JNPA_BerthingPlan', locationType: 'none' },
  { file: 'kpi_snapshots.csv', title: 'JNPA_KPISnapshots', locationType: 'none' },
];

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function post(url, form) {
  const res = await fetch(url, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(`${url} → ${json.error.message ?? JSON.stringify(json.error)}`);
  return json;
}

async function getToken() {
  const form = new FormData();
  form.set('username', USER);
  form.set('password', PASS);
  form.set('referer', PORTAL);
  form.set('f', 'json');
  const json = await post(`${PORTAL}/sharing/rest/generateToken`, form);
  if (!json.token) throw new Error('No token returned — check credentials.');
  return json.token;
}

/** Find an existing item owned by the user with this exact title + type. */
async function findItem(user, token, title, type) {
  const q = encodeURIComponent(`owner:${user} AND title:"${title}" AND type:"${type}"`);
  const json = await post(`${PORTAL}/sharing/rest/search?q=${q}&num=10&f=json&token=${token}`, undefined);
  const exact = (json.results || []).find((r) => r.title === title && r.type === type);
  return exact?.id ?? null;
}

/** Upload the CSV as a new item, returning its id. */
async function addCsvItem(user, token, title, csvText) {
  const form = new FormData();
  form.set('title', title);
  form.set('type', 'CSV');
  form.set('file', new Blob([csvText], { type: 'text/csv' }), `${title}.csv`);
  form.set('f', 'json');
  form.set('token', token);
  const json = await post(`${PORTAL}/sharing/rest/content/users/${user}/addItem`, form);
  return json.id;
}

/** Reuse the CSV item if it already exists, else upload it. */
async function ensureCsvItem(user, token, title, csvText) {
  const existing = await findItem(user, token, title, 'CSV');
  if (existing) return existing;
  return addCsvItem(user, token, title, csvText);
}

/**
 * Publish a CSV item as a Hosted Feature Layer using AGO's own analyzed
 * publishParameters (the minimal hand-rolled params are rejected as
 * success:false). We merge our location settings into the analyzed params.
 */
async function publishCsv(user, token, itemId, layer) {
  // 1) analyze → authoritative publishParameters (schema, field types, SR).
  const af = new FormData();
  af.set('itemid', itemId);
  af.set('filetype', 'csv');
  af.set('f', 'json');
  af.set('token', token);
  const analyze = await post(`${PORTAL}/sharing/rest/content/features/analyze`, af);
  const pp = analyze.publishParameters;
  pp.name = layer.title;
  pp.locationType = layer.locationType;
  if (layer.locationType === 'coordinates') {
    pp.latitudeFieldName = layer.latField;
    pp.longitudeFieldName = layer.lonField;
  }

  // 2) publish with the analyzed params.
  const form = new FormData();
  form.set('itemID', itemId);
  form.set('filetype', 'csv');
  form.set('publishParameters', JSON.stringify(pp));
  form.set('overwrite', 'true');
  form.set('f', 'json');
  form.set('token', token);
  const json = await post(`${PORTAL}/sharing/rest/content/users/${user}/publish`, form);
  const svc = json.services?.[0];
  if (!svc || svc.success === false) {
    throw new Error(`publish returned success:false (${JSON.stringify(svc)})`);
  }
  return svc.serviceurl ?? svc.encodedServiceURL;
}

/** Map each layer title → the .env var the URL should go into. */
const ENV_KEY = {
  JNPA_Berths: 'VITE_FS_BERTHS_URL',
  JNPA_Vessels: 'VITE_FS_VESSELS_URL',
  JNPA_PortCraft: 'VITE_FS_PORT_CRAFT_URL',
  JNPA_BerthingPlan: 'VITE_FS_BERTHING_PLAN_URL',
  JNPA_KPISnapshots: 'VITE_FS_KPI_SNAPSHOTS_URL',
};

async function main() {
  if (!USER || !PASS) die('Set ARCGIS_USER and ARCGIS_PASS (in .env or env vars).');
  const files = await readdir(SEED_DIR);
  console.log(`Portal: ${PORTAL}\nUser:   ${USER}\nSeed:   ${SEED_DIR} (${files.length} files)\n`);

  const token = await getToken();
  console.log('✓ Authenticated\n');

  const envLines = [];
  for (const layer of LAYERS) {
    process.stdout.write(`Publishing ${layer.title} … `);
    try {
      const csv = await readFile(join(SEED_DIR, layer.file), 'utf8');
      const itemId = await ensureCsvItem(USER, token, layer.title, csv);
      // A FeatureServer URL ends at /FeatureServer; the app appends /0 per layer.
      const url = await publishCsv(USER, token, itemId, layer);
      const layerUrl = `${url}/0`;
      console.log(`done\n   → ${layerUrl}`);
      envLines.push(`${ENV_KEY[layer.title]}=${layerUrl}`);
    } catch (err) {
      console.log('FAILED');
      console.error(`   ${err.message}`);
    }
  }

  console.log('\n=== Paste these into your .env, then restart the dev server ===');
  for (const line of envLines) console.log(line);
}

main().catch((err) => die(err.message));
