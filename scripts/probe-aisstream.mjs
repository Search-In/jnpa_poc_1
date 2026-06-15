#!/usr/bin/env node
/**
 * Probe the AISStream.io live feed for the JNPA / Nhava Sheva bounding box.
 * Standalone diagnostic — confirms the token works and real vessels are
 * broadcasting before wiring the app. Usage:
 *   node scripts/probe-aisstream.mjs [token] [seconds] [--wide]
 */
import { WebSocket } from 'ws';

const token = process.argv[2] || process.env.VITE_AISSTREAM_TOKEN || '';
const seconds = Number(process.argv[3]) || 25;
const wide = process.argv.includes('--wide');

// Default JNPA box; --wide opens the whole Mumbai/Arabian-Sea approach to prove
// the token works even if Nhava Sheva itself is momentarily quiet.
const bbox = wide ? [[18.0, 71.5], [19.6, 73.5]] : [[18.85, 72.85], [19.05, 73.05]];

if (!token) {
  console.error('No token. Pass as arg or set VITE_AISSTREAM_TOKEN.');
  process.exit(1);
}

console.log(`Connecting to AISStream… box=${JSON.stringify(bbox)} window=${seconds}s`);
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
const seen = new Map();
let frames = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ APIKey: token, BoundingBoxes: [bbox] }));
  console.log('Subscribed. Listening…');
});

ws.on('message', (buf) => {
  frames++;
  try {
    const m = JSON.parse(buf.toString());
    const md = m.MetaData;
    if (md?.MMSI) {
      const name = (md.ShipName || '').trim() || `MMSI ${md.MMSI}`;
      if (!seen.has(md.MMSI)) {
        seen.set(md.MMSI, name);
        console.log(`  • ${name}  (${md.latitude?.toFixed(3)}, ${md.longitude?.toFixed(3)})`);
      }
    } else if (m.error) {
      console.error('AISStream error:', m.error);
    }
  } catch {
    /* ignore */
  }
});

ws.on('error', (e) => console.error('WS error:', e.message));
ws.on('close', () => console.log('Closed.'));

setTimeout(() => {
  console.log(`\n=== RESULT: ${frames} frames, ${seen.size} unique vessels in ${seconds}s ===`);
  if (seen.size === 0) {
    console.log('No vessels. Either the box is quiet right now, or try: node scripts/probe-aisstream.mjs <token> 25 --wide');
  }
  ws.close();
  process.exit(0);
}, seconds * 1000);
