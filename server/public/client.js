// Browser side: no game code here. It shows frames the server streams and sends
// key presses back.

import qrcode from '/qrcode.mjs';

const KEYS = {
  ArrowUp: 0xad, ArrowDown: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
  KeyW: 0xad, KeyS: 0xaf, KeyA: 0xa0, KeyD: 0xa1,
  ControlLeft: 0xa3, ControlRight: 0xa3,
  Space: 0xa2, KeyE: 0xa2,
  ShiftLeft: 0xb6, ShiftRight: 0xb6,
  AltLeft: 0xb8, AltRight: 0xb8,
  Enter: 13, Escape: 27, Tab: 9, Backspace: 0x7f,
  KeyY: 121, KeyN: 110,
  Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53, Digit6: 54, Digit7: 55,
  Minus: 0x2d, Equal: 0x3d,
};

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const shareEl = document.getElementById('share');
const W = 320, H = 200, PIXELS = W * H;
const image = ctx.createImageData(W, H);
const rgba = new Uint32Array(image.data.buffer);

// /#<id> plays that game; /?watch=<token> watches it without controls. The
// token is a one-way hash of the id (server/store.js watchToken), so a watch
// link can't be used to play.
const watchToken = new URLSearchParams(location.search).get('watch');
const spectator = /^[0-9a-f]{32}$/.test(watchToken || '');
let gameId = spectator ? null : location.hash.slice(1) || null;
document.body.classList.toggle('spectator', spectator);

async function tokenFor(id) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`watch:${id}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function showShareLink() {
  if (spectator || !gameId) return;
  const link = new URL(`/?watch=${await tokenFor(gameId)}`, location.origin).href;
  shareEl.querySelector('a').href = link;
  shareEl.querySelector('a').textContent = link;
  shareEl.hidden = false;
}

// ---- QR code for the watch link, drawn in the browser (qrcode-generator, MIT) ----
const qrDialog = document.getElementById('qrDialog');
document.getElementById('qrButton').addEventListener('click', () => {
  const link = shareEl.querySelector('a').href;
  const qr = qrcode(0, 'M'); // 0 = smallest version that fits the link
  qr.addData(link);
  qr.make();
  document.getElementById('qrCode').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, title: 'QR code for the watch link' });
  document.getElementById('qrLink').textContent = link;
  qrDialog.showModal();
});
qrDialog.addEventListener('close', () => canvas.focus());

// ---- latency: browser <-> function round trip ----
// Best of the last five pings smooths out jitter. Behind CloudFront the reply
// carries x-amz-cf-pop, the edge location the browser connected to.
const REGION_NAMES = {
  'us-east-1': 'N. Virginia', 'us-east-2': 'Ohio', 'us-west-1': 'N. California', 'us-west-2': 'Oregon',
  'af-south-1': 'Cape Town', 'ap-east-1': 'Hong Kong', 'ap-south-1': 'Mumbai', 'ap-south-2': 'Hyderabad',
  'ap-southeast-1': 'Singapore', 'ap-southeast-2': 'Sydney', 'ap-southeast-3': 'Jakarta',
  'ap-southeast-4': 'Melbourne', 'ap-southeast-5': 'Malaysia', 'ap-southeast-7': 'Thailand',
  'ap-northeast-1': 'Tokyo', 'ap-northeast-2': 'Seoul', 'ap-northeast-3': 'Osaka',
  'ca-central-1': 'Canada Central', 'ca-west-1': 'Calgary', 'eu-central-1': 'Frankfurt', 'eu-central-2': 'Zurich',
  'eu-west-1': 'Ireland', 'eu-west-2': 'London', 'eu-west-3': 'Paris', 'eu-north-1': 'Stockholm',
  'eu-south-1': 'Milan', 'eu-south-2': 'Spain', 'il-central-1': 'Tel Aviv', 'me-central-1': 'UAE',
  'me-south-1': 'Bahrain', 'mx-central-1': 'Mexico', 'sa-east-1': 'São Paulo',
};
const latencyEl = document.getElementById('latency');
const rtts = [];
async function ping() {
  try {
    const t0 = performance.now();
    const res = await fetch(`/api/ping?t=${Date.now()}`, { cache: 'no-store' });
    const info = await res.json();
    rtts.push(performance.now() - t0);
    if (rtts.length > 5) rtts.shift();
    const city = REGION_NAMES[info.region];
    const parts = [
      `Served from ${info.region}${city ? ` (${city})` : ''}`,
      `you ↔ function ${Math.round(Math.min(...rtts))} ms`,
    ];
    const pop = res.headers.get('x-amz-cf-pop');
    if (pop) parts.push(`CloudFront edge ${pop}`);
    latencyEl.textContent = parts.join(' · ');
  } catch {
    latencyEl.textContent = 'Latency: no reply';
  }
}
ping();
setInterval(ping, 3000);

async function newGame() {
  const res = await fetch('/api/games', { method: 'POST' });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  gameId = (await res.json()).id;
  history.replaceState(null, '', `#${gameId}`);
}

// ---- input: send key changes as they happen, batched per animation frame ----
// Any environment can take the POST. The game's owner applies batches in seq
// order, so cid (this tab) + seq let it put them back in order.
const cid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
let seq = 0;
let pending = [];
let flushScheduled = false;
function queueKey(key, pressed) {
  if (spectator) return;
  pending.push([key, pressed]);
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      const keys = pending;
      pending = [];
      if (gameId) sendKeys({ cid, seq: ++seq, keys }, 0);
    });
  }
}

function sendKeys(batch, attempt) {
  fetch(`/api/games/${gameId}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
    keepalive: true,
  }).then((res) => {
    if (res.status >= 500 && attempt < 3) sendKeys(batch, attempt + 1);
  }).catch(() => {});
}
for (const type of ['keydown', 'keyup']) {
  canvas.addEventListener(type, (e) => {
    const key = KEYS[e.code];
    if (key === undefined) return;
    e.preventDefault();
    if (e.repeat) return;
    queueKey(key, type === 'keydown');
  });
}
canvas.addEventListener('blur', () => {
  // Release everything so the player doesn't keep running after focus leaves.
  for (const key of new Set(Object.values(KEYS))) queueKey(key, false);
});

// ---- frames: one deflate-compressed binary stream per connection ----
// Each frame: u32 tic | u8 flags | [768-byte palette if flags & 1] | 64000 bytes XOR previous frame
const prev = new Uint8Array(PIXELS);
const palette = new Uint32Array(256);
let frames = 0, bytesIn = 0, lastTic = 0;

let serving = '';
let lastServed = null; // `${environment}|${how}` of the previous stream
let notice = null;     // { text, until }: shown in place of the stats for a while
const NOTICE_MS = 10_000;

function playTime(tics) {
  const s = Math.round(tics / 35);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// What to tell a visitor about how this stream started, or null for nothing.
function describeStart(how, tics, ms) {
  const caughtUp = tics > 0 ? ` Caught up on ${playTime(tics)} of play in ${ms} ms.` : '';
  if (how.startsWith('handoff') || how === 'released') return `Moved to another server.${caughtUp}`;
  if (how === 'takeover') return `The last server stopped responding. Another one rebuilt your game in ${ms} ms.`;
  if (how === 'watch-copy') return 'Watching a copy of the game, about 1 s behind.';
  if (how === 'watch-owner') return 'Watching live.';
  return null; // 'new'
}

async function stream() {
  const res = await fetch(spectator ? `/api/watch/${watchToken}/stream` : `/api/games/${gameId}/stream`, { cache: 'no-store' });
  if (res.status === 404 && spectator) throw new Error('no game with that id (it may have ended)');
  if (!res.ok) throw new Error(`stream ${res.status}`);
  // Which environment serves the stream, and how: a new game, a game rebuilt
  // by replaying N tics after a handoff, or (spectators) the owner's own frames
  // or a copy that follows the owner's input log. Raw values go to the console;
  // the page shows a short sentence for 10 s, then goes back to the stats.
  const env = res.headers.get('x-doom-environment') || '?';
  const [how = '', ticsField = '', msField = ''] = (res.headers.get('x-doom-start') || '').split(';');
  const tics = Number(ticsField.slice(5)) || 0;
  const ms = Number(msField.slice(3)) || 0;
  console.log(`[doom] env ${env} · ${how} · replayed ${tics} tics in ${ms} ms`);
  serving = `server ${env.slice(0, 4)}`;
  // A reconnect to the same environment repeats that environment's original
  // start info, so only announce a change.
  const served = `${env}|${how}`;
  if (served !== lastServed) {
    const text = describeStart(how, tics, ms);
    if (text) notice = { text, until: Date.now() + NOTICE_MS };
  }
  lastServed = served;
  prev.fill(0);
  // Count bytes as they arrive from the network, before the decompressor, so
  // the status bar shows on-wire bandwidth (what deflate actually sends), not
  // the fixed ~64 KB per decoded frame. The tap sits in front of
  // DecompressionStream and passes each chunk through untouched.
  const counted = res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytesIn += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }));
  const reader = counted.pipeThrough(new DecompressionStream('deflate')).getReader();
  let buf = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf = concat(buf, value);
    let off = 0;
    for (;;) {
      if (buf.length - off < 5) break;
      const hasPalette = buf[off + 4] & 1;
      const size = 5 + (hasPalette ? 768 : 0) + PIXELS;
      if (buf.length - off < size) break;
      lastTic = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
      let p = off + 5;
      if (hasPalette) {
        for (let i = 0; i < 256; i++, p += 3) palette[i] = 0xff000000 | (buf[p + 2] << 16) | (buf[p + 1] << 8) | buf[p];
      }
      for (let i = 0; i < PIXELS; i++) {
        const v = prev[i] ^ buf[p + i];
        prev[i] = v;
        rgba[i] = palette[v];
      }
      frames++;
      off += size;
    }
    if (off) buf = buf.slice(off);
    ctx.putImageData(image, 0, 0);
  }
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

setInterval(() => {
  if (notice && Date.now() < notice.until) {
    statusEl.textContent = notice.text;
  } else {
    notice = null;
    statusEl.textContent = spectator || gameId
      ? `${frames} fps · ${(bytesIn / 1024).toFixed(0)} KB/s · ${serving || 'connecting'}`
      : 'starting a game…';
  }
  frames = 0;
  bytesIn = 0;
}, 1000);

// Reconnect forever: a dropped stream (network blip, request timeout) just
// reopens. A player whose game is gone starts a new one; a spectator waits.
for (;;) {
  try {
    if (!spectator && !gameId) await newGame();
    await showShareLink();
    await stream();
  } catch (err) {
    statusEl.textContent = `reconnecting: ${err.message}`;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
