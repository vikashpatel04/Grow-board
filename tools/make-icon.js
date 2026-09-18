/**
 * Generates build/icon.ico from the Grow Board mark, with no image
 * dependencies: the glyph is rasterised with signed-distance maths, encoded as
 * PNG with zlib, and wrapped in an ICO container (PNG-in-ICO, Vista onward).
 *
 * Run with: node tools/make-icon.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x19, 0x9e, 0x70];       // --series-3, the brand green
const FG = [0xff, 0xff, 0xff];

/* ---------------------------------------------------------------- geometry */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Distance from p to a rounded rectangle covering the whole canvas. */
function roundedRectDist(x, y, size, radius) {
  const hx = size / 2, hy = size / 2;
  const dx = Math.abs(x - hx) - (hx - radius);
  const dy = Math.abs(y - hy) - (hy - radius);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from p to a line segment. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? clamp((wx * vx + wy * vy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function render(size) {
  const s = size / 32;                       // the mark is designed on a 32px grid
  const pts = [[7, 22], [13, 15], [18, 19], [25, 9]].map(([x, y]) => [x * s, y * s]);
  const stroke = 3 * s / 2;                  // half-width
  const dotR = 2.6 * s;
  const radius = 7 * s;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // background plate
      const dBg = roundedRectDist(px, py, size, radius);
      const aBg = clamp(0.5 - dBg, 0, 1);

      // the rising line
      let dLine = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        dLine = Math.min(dLine, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
      }
      const aLine = clamp(0.5 - (dLine - stroke), 0, 1);

      // the dot at the top right
      const dDot = Math.hypot(px - pts[3][0], py - pts[3][1]) - dotR;
      const aDot = clamp(0.5 - dDot, 0, 1);

      const aFg = Math.max(aLine, aDot);
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        buf[o + c] = Math.round(BG[c] * (1 - aFg) + FG[c] * aFg);
      }
      buf[o + 3] = Math.round(255 * aBg);
    }
  }
  return buf;
}

/* --------------------------------------------------------------- PNG encode */

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function toPng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------------- ICO wrap */

function toIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

/* -------------------------------------------------------------------- main */

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(size => ({ size, data: toPng(render(size), size) }));
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), toIco(pngs));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].data);
console.log(`build/icon.ico written (${sizes.join(', ')} px)`);
console.log(`build/icon.png written (256 px)`);
