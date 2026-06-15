#!/usr/bin/env node
/**
 * publish-feature-layers.mjs — publish the seed CSVs in ./seed as Hosted
 * Feature Layers in your ArcGIS Online / Enterprise org.
 *
 * It uses the ArcGIS REST "generateToken → addItem (CSV) → publish" flow, the
 * same one the ArcGIS Online UI performs when you drag a CSV in. No SDK needed —
 * just Node 18+ (global fetch / FormData / Blob).
 *
 * Usage:
 *   ARCGIS_USER=you ARCGIS_PASS=secret \
 *   [ARCGIS_PORTAL=https://www.arcgis.com] \
 *   node scripts/publish-feature-layers.mjs
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

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTAL = process.env.ARCGIS_PORTAL ?? 'https://www.arcgis.com';
const USER = process.env.ARCGIS_USER;
const PASS = process.env.ARCGIS_PASS;
const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');

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

async function publishCsv(user, token, itemId, layer) {
  const publishParams = {
    name: layer.title,
    locationType: layer.locationType,
    ...(layer.locationType === 'coordinates'
      ? { latitudeFieldName: layer.latField, longitudeFieldName: layer.lonField }
      : {}),
  };
  const form = new FormData();
  form.set('itemID', itemId);
  form.set('filetype', 'csv');
  form.set('publishParameters', JSON.stringify(publishParams));
  form.set('f', 'json');
  form.set('token', token);
  const json = await post(`${PORTAL}/sharing/rest/content/users/${user}/publish`, form);
  return json.services?.[0]?.serviceurl ?? json.services?.[0]?.serviceItemId;
}

async function main() {
  if (!USER || !PASS) die('Set ARCGIS_USER and ARCGIS_PASS env vars.');
  const files = await readdir(SEED_DIR);
  console.log(`Portal: ${PORTAL}\nUser:   ${USER}\nSeed:   ${SEED_DIR} (${files.length} files)\n`);

  const token = await getToken();
  console.log('✓ Authenticated\n');

  for (const layer of LAYERS) {
    process.stdout.write(`Publishing ${layer.title} … `);
    try {
      const csv = await readFile(join(SEED_DIR, layer.file), 'utf8');
      const itemId = await addCsvItem(USER, token, layer.title, csv);
      const url = await publishCsv(USER, token, itemId, layer);
      console.log(`done\n   → ${url}\n`);
    } catch (err) {
      console.log('FAILED');
      console.error(`   ${err.message}\n`);
    }
  }

  console.log('Copy the service URLs above into your .env (VITE_FS_*_URL) and set VITE_DATA_MODE=live.');
}

main().catch((err) => die(err.message));
