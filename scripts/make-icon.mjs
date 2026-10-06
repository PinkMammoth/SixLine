// Generates the placeholder app icon (six tab lines + a red caret) as build/icon.png and build/icon.ico.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 256;
const px = Buffer.alloc(S * S * 4);
const set = (x, y, [r, g, b, a = 255]) => {
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};
const R = 40; // corner radius
for (let y = 0; y < S; y++)
  for (let x = 0; x < S; x++) {
    const dx = Math.max(R - x, x - (S - 1 - R), 0);
    const dy = Math.max(R - y, y - (S - 1 - R), 0);
    if (dx * dx + dy * dy <= R * R) set(x, y, [34, 40, 49]);
  }
for (let s = 0; s < 6; s++) {
  const y0 = 58 + s * 28;
  for (let y = y0; y < y0 + 5; y++) for (let x = 36; x < S - 36; x++) set(x, y, [226, 230, 236]);
}
for (let y = 110; y < 146; y++) for (let x = 140; x < 176; x++) set(x, y, [226, 64, 28]);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.concat(Array.from({ length: S }, (_, y) => Buffer.concat([Buffer.from([0]), px.subarray(y * S * 4, (y + 1) * S * 4)])));
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

// ICO with classic 32-bit BMP entries (16-256 px, nearest-neighbour), which every Windows tool and NSIS accept.
const sizes = [256, 48, 32, 16];
const images = sizes.map((n) => {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(n, 4);
  header.writeInt32LE(n * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const sx = Math.floor((x * S) / n);
      const sy = Math.floor(((n - 1 - y) * S) / n); // bottom-up rows
      const si = (sy * S + sx) * 4;
      const di = (y * n + x) * 4;
      xor[di] = px[si + 2]; xor[di + 1] = px[si + 1]; xor[di + 2] = px[si]; xor[di + 3] = px[si + 3];
    }
  const and = Buffer.alloc(Math.ceil(n / 32) * 4 * n);
  return Buffer.concat([header, xor, and]);
});
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((n, i) => {
  const e = 6 + i * 16;
  dir[e] = n === 256 ? 0 : n; dir[e + 1] = n === 256 ? 0 : n;
  dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', png);
fs.writeFileSync('build/icon.ico', Buffer.concat([dir, ...images]));
console.log('wrote build/icon.png, build/icon.ico');
