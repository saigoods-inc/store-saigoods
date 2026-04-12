/**
 * Storefront image helpers for Lighthouse: WebP + srcset, intrinsic dimensions (CLS),
 * and PNG/JPEG fallback when WebP variants are missing (e.g. before `npm run optimize:images`).
 */

/** Escape for double-quoted HTML attributes (incl. onerror=). */
function escAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

const RASTER_PATH = /\.(jpe?g|png|gif)$/i;

/**
 * If `url` is a raster path under /img, return { stem, fallbackPath } for WebP siblings.
 * SVG and data URLs return null (caller keeps a plain <img src>).
 */
export function toRasterStem(url) {
  const raw = String(url ?? "").trim();
  const pathOnly = raw.split("?")[0];
  if (!pathOnly || !RASTER_PATH.test(pathOnly)) {
    return null;
  }
  const dot = pathOnly.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return {
    stem: pathOnly.slice(0, dot),
    fallbackPath: pathOnly,
  };
}

/**
 * Default width/height for layout reserve (CLS). Tune per known catalog assets;
 * object-fit in CSS still refines the crop.
 */
export function rasterDimensionsForUrl(url) {
  const path = String(url ?? "").split("?")[0].toLowerCase();
  const file = path.split("/").pop() || "";

  if (path.includes("/product-listing/") || /^amazon-listing-img/.test(file)) {
    return { width: 800, height: 800 };
  }
  if (/sale-page\.png$/.test(path)) {
    return { width: 520, height: 663 };
  }
  if (/gloves-img\.png$/.test(path) || /gloves-img\.png$/.test(file)) {
    return { width: 800, height: 800 };
  }
  if (/boxes-stack/.test(file)) {
    return { width: 800, height: 600 };
  }
  return { width: 800, height: 800 };
}

/**
 * Responsive raster <img>: primary WebP + 400w/800w srcset, lazy/eager, decoding async,
 * onerror strips srcset and restores original raster (deploy-safe if WebP not built yet).
 *
 * @param {string} originalUrl - Catalog path (.jpg / .png)
 * @param {object} [options]
 * @param {string} [options.alt]
 * @param {string} [options.className]
 * @param {string} [options.sizes]
 * @param {"lazy"|"eager"} [options.loading]
 * @param {"high"|"low"|"auto"} [options.fetchpriority]
 * @param {number} [options.width] - Override intrinsic layout box
 * @param {number} [options.height]
 */
export function responsiveRasterImg(originalUrl, options = {}) {
  const {
    alt = "",
    className = "",
    sizes = "(max-width: 768px) 92vw, min(50vw, 32rem)",
    loading = "lazy",
    fetchpriority = "auto",
    width: widthOpt,
    height: heightOpt,
  } = options;

  const stemInfo = toRasterStem(originalUrl);
  const { width, height } =
    widthOpt != null && heightOpt != null
      ? { width: widthOpt, height: heightOpt }
      : rasterDimensionsForUrl(originalUrl);

  const cls = className ? ` class="${escAttr(className)}"` : "";
  const wh =
    Number.isFinite(width) && Number.isFinite(height)
      ? ` width="${width}" height="${height}"`
      : "";

  if (!stemInfo) {
    return `<img src="${escAttr(originalUrl)}" alt="${escAttr(alt)}"${wh}${cls} loading="${escAttr(loading)}" decoding="async" fetchpriority="${escAttr(fetchpriority)}" />`;
  }

  const { stem, fallbackPath } = stemInfo;
  const webpSrc = `${stem}.webp`;
  const webpSrcset = `${stem}-400.webp 400w, ${stem}-800.webp 800w`;
  const onerr = `this.onerror=null;this.removeAttribute('srcset');this.removeAttribute('sizes');this.src='${fallbackPath.replace(/'/g, "\\'")}';`;

  return `<img src="${escAttr(webpSrc)}" srcset="${escAttr(webpSrcset)}" sizes="${escAttr(sizes)}" alt="${escAttr(alt)}"${wh}${cls} loading="${escAttr(loading)}" decoding="async" fetchpriority="${escAttr(fetchpriority)}" onerror="${escAttr(onerr)}" />`;
}
