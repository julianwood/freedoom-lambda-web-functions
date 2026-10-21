// Unit test for the status bar's bandwidth counter (server/public/client.js).
//
// The bar must count bytes as they arrive from the network, BEFORE the
// DecompressionStream, so it reflects what deflate actually puts on the wire.
// A regression once counted the decompressed chunks instead, which is a fixed
// ~64 KB per frame (one 320x200 frame plus a 5-byte header), so the number sat
// near 1,100 KB/s at 17.5 fps no matter what the player did.
//
// client.js runs in the browser and can't be imported here, so this test
// reproduces the two counting strategies against the real byte stream the
// server produces: engine frames, XOR'd with the previous frame, through one
// deflate stream flushed per frame (see server/index.js). It asserts that the
// pre-decompression count equals the true compressed size and tracks motion,
// while the post-decompression count is the fixed decoded size and does not.
// Usage: node test/bandwidth-count.js

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DoomEngine, KEYS, TICRATE } from '../server/engine.js';

const engine = new DoomEngine();
const N = engine.width * engine.height;        // 320 * 200 = 64000
const HEADER = 5;                               // u32 tic | u8 flags
const DECODED_PER_FRAME = HEADER + N;           // what one frame decodes to, no palette

// Boot through the menu into a running level, then split play into two phases:
// standing still (frames barely change) and turning (every pixel changes).
const tap = (code, keysAt, t) => { keysAt[t] = [[KEYS[code], true]]; keysAt[t + 1] = [[KEYS[code], false]]; };
const keysAt = {};
tap('Escape', keysAt, 35);
tap('Enter', keysAt, 50);
tap('Enter', keysAt, 65);
tap('Enter', keysAt, 80);
const START = TICRATE * 4;                       // give the level time to load
const PHASE = TICRATE * 4;                        // tics per phase
keysAt[START + PHASE] = [[KEYS.ArrowRight, true]]; // start turning for phase 2

// Collect encoded frames (header + XOR-with-previous), one per server send.
// The server sends every second tic (FRAME_INTERVAL_TICS = 2).
const prev = new Uint8Array(N);
const still = [];
const turning = [];
for (let t = 0; t < START + 2 * PHASE; t++) {
  engine.step(keysAt[t] || []);
  const frame = engine.pixels(); // a view into WASM memory, valid until the next step()
  if (t < START || t % 2 !== 0) { for (let i = 0; i < N; i++) prev[i] = frame[i]; continue; }
  const enc = new Uint8Array(DECODED_PER_FRAME);
  enc[0] = t & 0xff; enc[1] = (t >> 8) & 0xff; enc[2] = (t >> 16) & 0xff; enc[3] = (t >> 24) & 0xff;
  for (let i = 0; i < N; i++) { enc[HEADER + i] = frame[i] ^ prev[i]; prev[i] = frame[i]; }
  (t < START + PHASE ? still : turning).push(enc);
}
assert.ok(still.length > 10 && turning.length > 10, 'both phases produced frames');

// Push a phase's frames through one deflate stream, flushed per frame like the
// server, and count bytes the two ways client.js could: on the wire (the
// compressed chunks, the fix) and after decompression (the decoded chunks, the
// bug).
function countBoth(frames) {
  const deflate = zlib.createDeflate({ level: 6 });
  const inflate = zlib.createInflate();
  let onWire = 0, decoded = 0;
  deflate.on('data', (c) => { onWire += c.length; inflate.write(c); });
  inflate.on('data', (c) => { decoded += c.length; });
  return new Promise((resolve) => {
    (async () => {
      for (const f of frames) {
        deflate.write(Buffer.from(f));
        await new Promise((r) => deflate.flush(zlib.constants.Z_SYNC_FLUSH, r));
      }
      deflate.end();
      deflate.on('end', () => inflate.end());
      inflate.on('end', () => resolve({ onWire, decoded }));
    })();
  });
}

const s = await countBoth(still);
const m = await countBoth(turning);

// 1) The decoded (buggy) count is the fixed frame size times the frame count,
//    for both phases. That is why the buggy bar never moved.
assert.equal(s.decoded, still.length * DECODED_PER_FRAME, 'still: decoded = frames * frame size');
assert.equal(m.decoded, turning.length * DECODED_PER_FRAME, 'turning: decoded = frames * frame size');

// 2) Per-frame decoded bytes are identical whether still or turning: a counter
//    on the decompressed side cannot tell motion from stillness.
assert.equal(s.decoded / still.length, m.decoded / turning.length, 'decoded bytes/frame constant across motion');

// 3) The on-wire (fixed) count DOES track motion: a still screen compresses to
//    a small fraction of a frame, turning to much more. Use a conservative
//    factor so the test is not flaky across zlib versions.
const stillPerFrame = s.onWire / still.length;
const turnPerFrame = m.onWire / turning.length;
assert.ok(stillPerFrame < DECODED_PER_FRAME * 0.25, `still compresses small (${stillPerFrame.toFixed(0)} B/frame)`);
assert.ok(turnPerFrame > stillPerFrame * 3, `turning uses far more on the wire (${turnPerFrame.toFixed(0)} vs ${stillPerFrame.toFixed(0)} B/frame)`);

// 4) The on-wire count is always less than the decoded count: deflate never
//    expands this data, so the correct bar reads below the buggy one.
assert.ok(s.onWire < s.decoded && m.onWire < m.decoded, 'on-wire < decoded');

console.log(JSON.stringify({
  frameSize: DECODED_PER_FRAME,
  still: { frames: still.length, onWireBytesPerFrame: Math.round(stillPerFrame), decodedBytesPerFrame: s.decoded / still.length },
  turning: { frames: turning.length, onWireBytesPerFrame: Math.round(turnPerFrame), decodedBytesPerFrame: m.decoded / turning.length },
  pass: true,
}));
