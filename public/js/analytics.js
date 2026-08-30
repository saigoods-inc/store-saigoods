const CURRENCY = "USD";
const PURCHASE_SESSION_PREFIX = "saigoods-ga4-purchase:";

let analyticsInitPromise = null;

function ensureGtagQueue() {
  window.dataLayer = window.dataLayer || [];
  window.gtag =
    window.gtag ||
    function gtag() {
      window.dataLayer.push(arguments);
    };
}

function localAnalyticsEnabled() {
  const host = String(window.location.hostname || "").toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  return !isLocal || new URLSearchParams(window.location.search).get("ga_debug") === "1";
}

export function initAnalytics() {
  if (analyticsInitPromise) {
    return analyticsInitPromise;
  }

  ensureGtagQueue();
  analyticsInitPromise = (async () => {
    if (!localAnalyticsEnabled()) {
      return false;
    }

    try {
      const response = await fetch("/api/analytics-config", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const config = await response.json();
      if (!response.ok || !config?.enabled || !config?.measurementId) {
        return false;
      }

      if (!document.querySelector('script[data-sai-ga4="true"]')) {
        const script = document.createElement("script");
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
          config.measurementId,
        )}`;
        script.dataset.saiGa4 = "true";
        document.head.appendChild(script);
      }

      window.gtag("js", new Date());
      window.gtag("config", config.measurementId, {
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        debug_mode: new URLSearchParams(window.location.search).get("ga_debug") === "1",
      });
      return true;
    } catch {
      return false;
    }
  })();

  return analyticsInitPromise;
}

function sendEvent(name, parameters = {}) {
  void initAnalytics().then((enabled) => {
    if (enabled) {
      window.gtag("event", name, parameters);
    }
  });
}

function centsToUsd(cents) {
  const value = Number(cents);
  return Number.isFinite(value) ? Math.max(0, value) / 100 : 0;
}

function quoteItemsToGa4(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    item_id: String(item?.slug || `item-${index + 1}`),
    item_name: String(item?.name || item?.shortName || item?.slug || "Store item"),
    index,
    price: centsToUsd(item?.lineTotalCents ?? item?.priceCents),
    quantity: 1,
    case_count: Math.max(0, Number(item?.lineCases) || 0),
    box_count: Math.max(0, Number(item?.lineBoxCount) || 0),
  }));
}

function quoteValue(quote) {
  return centsToUsd(quote?.subtotalCents ?? quote?.totalCents);
}

export function trackViewItemList(products, listName = "Store catalog") {
  const items = (Array.isArray(products) ? products : []).map((product, index) => ({
    item_id: String(product?.slug || `item-${index + 1}`),
    item_name: String(product?.name || product?.shortName || product?.slug || "Store item"),
    index,
    price: centsToUsd(product?.priceCents),
    quantity: 1,
  }));
  if (items.length) {
    sendEvent("view_item_list", { item_list_name: listName, items });
  }
}

export function trackViewItem(product) {
  if (!product) {
    return;
  }
  const caseBundle = product.bundles?.find((bundle) => bundle.id === "case_1");
  const priceCents = caseBundle?.priceCents ?? product.priceCents;
  sendEvent("view_item", {
    currency: CURRENCY,
    value: centsToUsd(priceCents),
    items: [
      {
        item_id: String(product.slug),
        item_name: String(product.name || product.shortName || product.slug),
        price: centsToUsd(priceCents),
        quantity: 1,
      },
    ],
  });
}

export function trackAddToCart(quote) {
  const gaItems = quoteItemsToGa4(quote?.items);
  if (gaItems.length) {
    sendEvent("add_to_cart", { currency: CURRENCY, value: quoteValue(quote), items: gaItems });
  }
}

export function trackViewCart(quote) {
  const gaItems = quoteItemsToGa4(quote?.items);
  if (gaItems.length) {
    sendEvent("view_cart", { currency: CURRENCY, value: quoteValue(quote), items: gaItems });
  }
}

export function trackRemoveFromCart(item) {
  const gaItems = quoteItemsToGa4(item ? [item] : []);
  if (gaItems.length) {
    sendEvent("remove_from_cart", {
      currency: CURRENCY,
      value: centsToUsd(item.lineTotalCents),
      items: gaItems,
    });
  }
}

export function trackBeginCheckout(quote) {
  const gaItems = quoteItemsToGa4(quote?.items);
  if (gaItems.length) {
    sendEvent("begin_checkout", {
      currency: CURRENCY,
      value: quoteValue(quote),
      items: gaItems,
    });
  }
}

export function trackPurchase(order) {
  const transactionId = String(order?.orderRef || order?.orderId || "").trim();
  const gaItems = quoteItemsToGa4(order?.items);
  if (!transactionId || !gaItems.length) {
    return;
  }

  try {
    const key = `${PURCHASE_SESSION_PREFIX}${transactionId}`;
    if (sessionStorage.getItem(key) === "1") {
      return;
    }
    sessionStorage.setItem(key, "1");
  } catch {
    // A blocked storage API should not prevent purchase measurement.
  }

  sendEvent("purchase", {
    transaction_id: transactionId,
    affiliation: "SAI Goods online store",
    currency: CURRENCY,
    value: centsToUsd(order.subtotalCents),
    tax: centsToUsd(order.taxCents),
    shipping: centsToUsd(order.shippingCents),
    items: gaItems,
  });
}
