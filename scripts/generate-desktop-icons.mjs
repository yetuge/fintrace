import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'web', 'package.json'));
const sharp = require('sharp');
const source = path.join(root, 'web', 'public', 'fintrace.svg');
const assets = path.join(root, 'electron', 'assets');
await fs.mkdir(assets, { recursive: true });
const png = (size) => sharp(source).resize(size, size).png().toBuffer();
await fs.writeFile(path.join(assets, 'fintrace.png'), await png(1024));

const sizes = [16, 32, 48, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [i, size] of sizes.entries()) {
  const entry = 6 + i * 16;
  header[entry] = size % 256;
  header[entry + 1] = size % 256;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await fs.writeFile(
  path.join(assets, 'fintrace.ico'),
  Buffer.concat([header, ...images]),
);

const chunks = await Promise.all(
  [
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ].map(async ([type, size]) => {
    const image = await png(size);
    const chunk = Buffer.alloc(8);
    chunk.write(type);
    chunk.writeUInt32BE(image.length + 8, 4);
    return Buffer.concat([chunk, image]);
  }),
);
const icns = Buffer.alloc(8);
icns.write('icns');
icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await fs.writeFile(
  path.join(assets, 'fintrace.icns'),
  Buffer.concat([icns, ...chunks]),
);
