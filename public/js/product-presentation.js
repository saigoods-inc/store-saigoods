import { examinationDetails, blackGloveDetails } from "./product-details-content.js";
import { responsiveRasterImg } from "./image-utils.js";
import { escapeHtml } from "./home-cards.js";

const PRODUCT_SEO_COPY = {
  "nitrile-standard": {
    heading: "LYDUS® 4 Mil Nitrile Examination Gloves",
    title: "LYDUS® 4 Mil Nitrile Examination Gloves | SAI Goods",
  },
  "black-nitrile-general": {
    heading: "LYDUS® 5 Mil Black Nitrile Gloves — General",
    title: "LYDUS® 5 Mil Black Nitrile Gloves | SAI Goods",
  },
  "black-nitrile-heavy-duty": {
    heading: "LYDUS® 8 Mil Black Nitrile Gloves — Heavy Duty",
    title: "LYDUS® 8 Mil Black Nitrile Gloves | SAI Goods",
  },
};

function productSeoCopy(currentProduct) {
  return PRODUCT_SEO_COPY[currentProduct.slug] || {
    heading: currentProduct.name,
    title: `${currentProduct.name} | SAI Goods`,
  };
}

function productHeadingHtml(currentProduct) {
  const heading = productSeoCopy(currentProduct).heading;
  const brand = "LYDUS®";
  if (!heading.startsWith(brand)) return escapeHtml(heading);
  return `<span class="product-brand">LYDUS<sup>®</sup></span>${escapeHtml(heading.slice(brand.length))}`;
}

export function casePackagingNoteHtml(product) {
  const boxes = Math.max(1, Math.floor(Number(product.boxesPerCase) || 10));
  const pieces = boxes * 100;
  const boxNoun = boxes === 1 ? "box" : "boxes";
  return `<strong>100 gloves</strong> per box · <strong>${boxes} ${boxNoun}</strong> per case · <strong>${pieces.toLocaleString("en-US")} gloves</strong> total`;
}

export function detailRows(rows) {
  return `<div class="spec-list">${rows.map(([label, value]) => `<div class="spec-list__row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
}
export function detailBullets(rows) {
  return `<ul>${rows.map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`).join("")}</ul>`;
}
export function currentDetails(product) {
  if (blackGloveDetails[product.slug]) return blackGloveDetails[product.slug];
  return product.slug === "nitrile-standard" ? examinationDetails : {
    highlights: (product.specs || []).filter(s => /texture|cuff|material/i.test(s.label)).map(s => [s.label,s.value]),
    specifications: (product.specs || []).map(s => [s.label,s.value]),
    standards: [], full: (product.specs || []).map(s => [s.label,s.value]),
  };
}
export function renderProductDetails(product, openPanels = new Set()) {
  const content = currentDetails(product);
  const panel = (id, title, html) => `<details class="product-accordion" data-panel="${id}" ${openPanels.has(id) ? "open" : ""}><summary>${title}</summary><div class="product-accordion__content">${html}</div></details>`;
  return `<div class="product-accordions">
    ${panel("highlights", "Product highlights", detailBullets(content.highlights))}
    ${panel("specifications", "Key specifications", detailRows(content.specifications))}
    ${panel("documentation", "Standards &amp; documentation", content.documentation ? `<p>${escapeHtml(content.documentation)}</p><p>For documentation, contact <a href="mailto:sales@saigoods.com">sales@saigoods.com</a>.</p>` : content.standards.length ? `${detailBullets(content.standards)}` : `<p>Contact <a href="mailto:sales@saigoods.com">sales@saigoods.com</a> for this product’s documentation.</p>`)}
  </div><button type="button" class="product-full-details" data-action="full-details">View full details</button>`;
}

export function renderProductIntro(product, {selectedImageIndex = 0, openPanels = new Set(), interactive = false} = {}) {
  const thumbIndexes = (product.gallery?.length ? product.gallery : [product.cardImage]).slice(0, 4).map((_, index) => index);
  product = {...product, gallery: product.gallery?.length ? product.gallery : [product.cardImage]};
  return `
    <a class="product-back" href="/#products">← Back to shop</a>
    <section class="product-layout">
      <div class="product-gallery">
        <div class="product-gallery__thumbs">
          ${thumbIndexes
            .map(
              (index) => `
                <button
                  class="product-gallery__thumb ${selectedImageIndex === index ? "is-active" : ""}"
                  type="button"
                  data-thumb-index="${index}"
                  aria-label="View product image ${index + 1}"
                >
                  ${responsiveRasterImg(product.gallery[index], {
                    alt: `${product.name} image ${index + 1}`,
                    loading: index === selectedImageIndex ? "eager" : "lazy",
                    fetchpriority: index === 0 ? "high" : "auto",
                    sizes: "(max-width: 768px) 22vw, 120px",
                  })}
                </button>
              `,
            )
            .join("")}
        </div>

        <div class="product-gallery__main" tabindex="0" role="region" aria-label="Product images; swipe or use arrow keys">
          ${(interactive ? [thumbIndexes.at(-1), ...thumbIndexes, thumbIndexes[0]] : [thumbIndexes[0]]).map((index, position) => `<div class="product-gallery__slide" ${interactive && (position === 0 || position === thumbIndexes.length + 1) ? 'aria-hidden="true"' : ''}>${responsiveRasterImg(product.gallery[index], {alt: `${product.name} image ${index + 1}`, loading: 'eager', sizes: '(max-width: 800px) 90vw, 520px'})}</div>`).join('')}
        </div>
        <p class="product-gallery__pack-note">${casePackagingNoteHtml(product)}</p>
      </div>

      <div class="product-info">
        <div class="product-title"><p class="product-brand">LYDUS®</p><h1>${escapeHtml(productSeoCopy(product).heading.replace(/^LYDUS®\s*/, ""))}</h1><div class="product-tags">${(currentDetails(product).tags || (product.specs || []).filter(s => /powder|sterility|color/i.test(s.label)).map(s => s.value)).map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</div></div>
        <div class="product-info__intro">
          <p class="product-info__copy">${escapeHtml(product.description)}</p>
          <p class="product-shipping"><img src="/img/product-shipping.svg" alt="" width="15" height="11"><span>Shipping arrives in <strong>3–5 days</strong></span></p>

        </div>

        ${renderProductDetails(product, openPanels)}

`;
}
