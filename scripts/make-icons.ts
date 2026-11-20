// Generate the PNG app icons (same design as public/icon.svg) without extra dependencies.
// Run: npx tsx scripts/make-icons.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ROOT } from './lib';

const BG = [0x1f, 0x29, 0x33];
const LIGHT = [0xf0, 0xd9, 0xb5];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Checkerboard logo; `inset` keeps the pattern inside the maskable safe zone. */
function icon(size: number, inset: number): Buffer {
  const rows: Buffer[] = [];
  const start = Math.round(size * inset);
  const span = size - 2 * start;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte + RGB
    for (let x = 0; x < size; x++) {
      let color = BG;
      const gx = x - start;
      const gy = y - start;
      if (gx >= 0 && gy >= 0 && gx < span && gy < span) {
        const cx = Math.floor((gx / span) * 4);
        const cy = Math.floor((gy / span) * 4);
        if ((cx + cy) % 2 === 0) color = LIGHT;
      }
      row.set(color, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = join(ROOT, 'public');
writeFileSync(join(out, 'icon-192.png'), icon(192, 0.125));
writeFileSync(join(out, 'icon-512.png'), icon(512, 0.125));
writeFileSync(join(out, 'icon-maskable-512.png'), icon(512, 0.22)); // inside the 80% safe zone
writeFileSync(join(out, 'apple-touch-icon.png'), icon(180, 0.125));
console.log('icons written to public/');
