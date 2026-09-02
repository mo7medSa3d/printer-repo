#!/usr/bin/env node
import sharp from "sharp";
import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcSvg = join(root, "src-tauri/icons/icon-source.svg");
const outDir = join(root, "src-tauri/icons");
const odooIcon = join(root, "odoo_addons/print_gateway/static/description/icon.png");

const sizes = [
  { name: "16x16.png", size: 16 },
  { name: "24x24.png", size: 24 },
  { name: "32x32.png", size: 32 },
  { name: "48x48.png", size: 48 },
  { name: "64x64.png", size: 64 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
  { name: "icon-source.png", size: 1024 },
];

async function generatePNGs() {
  const svgBuf = await readFile(srcSvg);
  console.log(`Source SVG: ${svgBuf.length} bytes`);

  for (const { name, size } of sizes) {
    const outPath = join(outDir, name);
    await sharp(svgBuf)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outPath);
    console.log(`✓ ${name} (${size}x${size})`);
  }

  // Odoo icon 512
  await sharp(svgBuf)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(odooIcon);
  console.log(`✓ odoo_addons/print_gateway/static/description/icon.png (512)`);

  // Also generate public favicon and app icon for Next.js
  const publicIcon = join(root, "src/app/icon.png");
  try {
    await sharp(svgBuf).resize(512, 512).png().toFile(publicIcon);
    console.log(`✓ src/app/icon.png (512)`);
  } catch {}
  try {
    const favicon32 = join(root, "src/app/favicon.ico.png");
    await sharp(svgBuf).resize(32, 32).png().toFile(join(root, "public/favicon.png").replace("public/favicon.png","public/favicon.png"));
  } catch {}
}

async function generateICO() {
  const svgBuf = await readFile(srcSvg);
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = [];
  for (const s of icoSizes) {
    const buf = await sharp(svgBuf)
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push({ size: s, buf });
  }

  // Build ICO with PNG entries (Vista+ style)
  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type ico
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(entrySize * count);
  let offset = headerSize + entrySize * count;
  const images = [];

  for (let i = 0; i < count; i++) {
    const { size, buf } = pngBuffers[i];
    const entryOffset = i * entrySize;
    entries[entryOffset] = size === 256 ? 0 : size; // width 0 means 256
    entries[entryOffset + 1] = size === 256 ? 0 : size; // height
    entries[entryOffset + 2] = 0; // color count
    entries[entryOffset + 3] = 0; // reserved
    entries.writeUInt16LE(1, entryOffset + 4); // planes
    entries.writeUInt16LE(32, entryOffset + 6); // bitCount
    entries.writeUInt32LE(buf.length, entryOffset + 8); // bytesInRes
    entries.writeUInt32LE(offset, entryOffset + 12); // imageOffset
    offset += buf.length;
    images.push(buf);
  }

  const icoPath = join(outDir, "icon.ico");
  const icoBuf = Buffer.concat([header, entries, ...images]);
  await writeFile(icoPath, icoBuf);
  console.log(`✓ icon.ico (${icoBuf.length} bytes, ${count} images PNG)`);
}

async function main() {
  console.log("Generating modern icons from SVG...");
  await generatePNGs();
  await generateICO();
  console.log("\nAll icons generated successfully - strong modern look!");
  console.log("Preview: src-tauri/icons/icon.png and odoo icon");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
