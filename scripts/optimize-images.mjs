#!/usr/bin/env node
/**
 * Generates WebP variants next to each source PNG/JPEG under public/img:
 *   <stem>.webp, <stem>-400.webp, <stem>-800.webp
 * Matches responsiveRasterImg() in public/js/image-utils.js.
 *
 * Run from repo root: npm run optimize:images
 * Requires raster files to exist locally (not always committed).
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(process.cwd(), "public/img");

async function collectRasters(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectRasters(full)));
      continue;
    }
    if (!/\.(jpe?g|png)$/i.test(ent.name)) {
      continue;
    }
    if (/-(400|800)\.(jpe?g|png)$/i.test(ent.name)) {
      continue;
    }
    out.push(full);
  }
  return out;
}

async function processFile(absPath) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const stem = base.replace(/\.(jpe?g|png)$/i, "");
  const relStem = path.join(dir, stem);

  const meta = await sharp(absPath).metadata();

  const writeWebp = async (label, maxWidth) => {
    let pipeline = sharp(absPath).rotate();
    if (maxWidth && meta.width && meta.width > maxWidth) {
      pipeline = pipeline.resize({
        width: maxWidth,
        withoutEnlargement: true,
      });
    }
    const suffix = label ? `-${label}` : "";
    const dest = `${relStem}${suffix}.webp`;
    await pipeline.webp({ quality: 80, effort: 5 }).toFile(dest);
    console.log("wrote", path.relative(process.cwd(), dest));
  };

  await writeWebp("", 1600);
  await writeWebp("400", 400);
  await writeWebp("800", 800);
}

const files = await collectRasters(ROOT);
if (!files.length) {
  console.warn("No PNG/JPEG files under public/img — nothing to optimize.");
  process.exit(0);
}

for (const f of files) {
  try {
    await processFile(f);
  } catch (e) {
    console.error("failed:", f, e);
    process.exitCode = 1;
  }
}
