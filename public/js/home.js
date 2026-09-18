import { renderCatalogCards } from "./home-cards.js";
import { initSite } from "./site.js";
import { trackViewItemList } from "./analytics.js";

const productGrid = document.querySelector("[data-product-grid]");

let store;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const arrivalHash = window.location.hash;
  try {
    store = await initSite({ page: "home" });
    document.querySelector(".brand-mark__name").textContent = store.site.legalName;
    productGrid.innerHTML = renderCatalogCards(store.products);
    trackViewItemList(store.products);
  } catch {
    // Keep the static cards usable when live availability cannot be refreshed.
    productGrid.dataset.refreshFailed = "true";
  } finally {
    productGrid.setAttribute("aria-busy", "false");
    // Header, catalog and fonts change section positions after native fragment navigation.
    // Align once the homepage layout is ready, without overriding a newer destination.
    if (arrivalHash) {
      await document.fonts.ready;
      requestAnimationFrame(() => {
        if (window.location.hash !== arrivalHash) return;
        const target = document.getElementById(arrivalHash.slice(1));
        target?.scrollIntoView({ behavior: "instant", block: "start" });
      });
    }
  }
}
