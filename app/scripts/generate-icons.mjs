// Generates PWA icons (PNG) without extra dependencies: the tutor "flame" —
// a coral→lilac glowing orb with a white four-point star (docs/04 §0).
// Usage: npm run icons   (writes public/icons/*.png)
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const BG = [0xfa, 0xf6, 0xef];
const CORAL = [0xff, 0x7a, 0x50];
const LILAC = [0x7c, 0x6c, 0xf0];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 3; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const [r, g, b, a] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = acc[3] / (SS * SS);
      raw[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      raw[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      raw[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      raw[o + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** orbRadius: fraction of the icon; background: fill the square (maskable) or not. */
function icon({ orbRadius, background }) {
  return (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.hypot(dx, dy);
    // Four-point star: |x|^p + |y|^p <= r^p with p < 1.
    const r = orbRadius * 0.55, p = 0.55;
    const inStar = Math.pow(Math.abs(dx) / r, p) + Math.pow(Math.abs(dy) / r, p) <= 1;
    if (d <= orbRadius) {
      if (inStar) return [255, 255, 255, 1];
      // radial gradient from a light point at 35%/30% (lilac) to coral
      const t = Math.min(1, Math.hypot(u - (0.5 - orbRadius * 0.3), v - (0.5 - orbRadius * 0.4)) / (orbRadius * 1.5));
      return [...mix(LILAC, CORAL, t), 1];
    }
    return background ? [...BG, 1] : [0, 0, 0, 0];
  };
}

mkdirSync(OUT, { recursive: true });
const files = {
  "icon-192.png": png(192, icon({ orbRadius: 0.46, background: false })),
  "icon-512.png": png(512, icon({ orbRadius: 0.46, background: false })),
  // Maskable: full-bleed background, content inside the 80% safe zone.
  "icon-maskable-512.png": png(512, icon({ orbRadius: 0.34, background: true })),
  "apple-touch-icon.png": png(180, icon({ orbRadius: 0.4, background: true })),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.warn(`wrote public/icons/${name} (${data.length} bytes)`);
}
