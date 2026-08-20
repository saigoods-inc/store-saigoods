export type SummaryPreset = "today" | "last7" | "last30" | "month" | "all";

export interface SummaryKpis {
  currentProfitCents?: number;
  totalOrders?: number;
  totalRevenueCents?: number;
  averageOrderValueCents?: number;
  totalShippingExpenseCents?: number;
  totalSquareProcessingFeesCents?: number;
  actualSquareProcessingFeesCents?: number;
  estimatedSquareProcessingFeesCents?: number;
  averageSquareProcessingFeeCents?: number;
  squareFeeOrders?: number;
  actualSquareFeeOrders?: number;
  estimatedSquareFeeOrders?: number;
  totalShippingVarianceCents?: number;
  averageShippingPerOrderCents?: number;
  netAfterVariableCostsCents?: number;
  inventorySellThroughRevenueCents?: number;
  inventorySellThroughCaseUnits?: number;
  inventorySellThroughBoxUnits?: number;
  websiteOrders?: number;
  marketplaceOrders?: number;
  marketplaceProfitCompleteOrders?: number;
  marketplaceProfitEstimatedOrders?: number;
}

export class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export interface SalesOverviewProduct {
  slug: string;
  name?: string;
  label?: string;
  revenueCents: number;
}

export interface SalesOverviewBucket {
  bucketStart: string;
  totalRevenueCents: number;
  shippingExpenseCents: number;
  products: SalesOverviewProduct[];
}

export interface ProductRankingRow {
  slug: string;
  name?: string;
  revenueCents: number;
  orderCount?: number;
  quantityUnits?: number;
}

export interface RecentOrderRow {
  orderRef?: string;
  customer?: string;
  orderStatus?: string;
  quantityPreview?: string;
  revenueCents?: number;
  paidAt?: string;
  channel?: string;
  currentProfitCents?: number | null;
  currentProfitEstimated?: boolean;
}

export interface SummaryResponse {
  generatedAt?: string;
  dateRange?: {
    preset?: SummaryPreset;
    start?: string;
    end?: string;
    bucketMode?: "day" | "week";
  };
  kpis?: SummaryKpis;
  charts?: {
    revenueTrend?: Array<{ bucketStart: string; revenueCents: number }>;
  };
  breakdown?: {
    recentFinancialActivity?: RecentOrderRow[];
    productRanking?: ProductRankingRow[];
    salesOverviewSeries?: {
      products?: Array<{ slug: string; name?: string; label?: string }>;
      buckets?: SalesOverviewBucket[];
    };
  };
  alerts?: {
    missingShippingCost?: { count?: number; rows?: Array<{ orderRef?: string; reason?: string }> };
    paidNotFulfilled?: { count?: number; rows?: Array<{ orderRef?: string; customer?: string; orderStatus?: string }> };
    feeCalculationIssues?: { count?: number; rows?: Array<{ orderRef?: string; reason?: string }> };
    unusuallyHighShipping?: { count?: number; rows?: Array<{ orderRef?: string; shippingExpenseCents?: number; revenueCents?: number }> };
    marketplaceFinancialsIncomplete?: { count?: number; rows?: Array<{ marketplace?: string; externalOrderId?: string }> };
    inventoryOutOfStock?: { count?: number; rows?: Array<{ slug?: string; size?: string }> };
    lowInventory?: { count?: number; rows?: Array<{ slug?: string; size?: string }> };
    incomingBatchesOnHold?: { count?: number; rows?: Array<{ batch_name?: string }> };
  };
}

export interface NexusSummaryRow {
  state: string;
  total_revenue: number;
  total_orders: number;
}

export interface NexusSummaryResponse {
  generated_at?: string;
  currency?: string;
  summary?: NexusSummaryRow[];
}

export interface DiscountCodeRow {
  code?: string;
  percent_off?: number | null;
  is_used?: boolean;
  used_at?: string | null;
  used_by_order_id?: string | null;
  created_at?: string | null;
}

export interface DiscountCodesResponse {
  generated_at?: string;
  codes?: DiscountCodeRow[];
}

export interface CreateDiscountCodeResponse {
  code?: DiscountCodeRow;
}

export interface ShippingHealthResponse {
  generatedAt?: string;
  telemetryAvailable?: boolean;
  warning?: string;
  runtime?: {
    provider?: string;
    providerConfigured?: boolean;
    tokenConfigured?: boolean;
    shippoConfigured?: boolean;
    tokenMode?: "test" | "live" | "missing";
    carrierAccountCount?: number;
    warehouseConfigured?: boolean;
    fallbackEnabled?: boolean;
    databasePurchaseLockEnabled?: boolean;
    checkoutAddressValidationEnabled?: boolean;
    checkoutAddressValidationReady?: boolean;
    warehouseAddressValidationReady?: boolean;
  };
  last24Hours?: {
    total?: number;
    counts?: Record<string, number>;
  };
  recent?: Array<{
    event_type?: string;
    outcome?: string;
    error_code?: string | null;
    parcel_count?: number | null;
    rate_count?: number | null;
    duration_ms?: number | null;
    created_at?: string;
  }>;
}

export interface PaymentHealthResponse {
  generatedAt?: string;
  runtime?: {
    provider?: "square";
    environment?: "sandbox" | "production" | "missing" | "invalid";
    environmentConfigured?: boolean;
    sandboxPolicyCompliant?: boolean;
    accessTokenConfigured?: boolean;
    applicationIdConfigured?: boolean;
    locationIdConfigured?: boolean;
    publicBaseUrlConfigured?: boolean;
    databaseConfigured?: boolean;
    webhookSignatureConfigured?: boolean;
    coreConfigured?: boolean;
    embeddedCheckoutReady?: boolean;
    paymentLinkReady?: boolean;
    resendApiKeyConfigured?: boolean;
    resendFromConfigured?: boolean;
    paymentLinkEmailReady?: boolean;
  };
}

export interface WarehouseLocation {
  key: string;
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  email: string;
  phone: string;
  roles: string[];
  active: boolean;
}

export interface WarehouseConfigResponse {
  ok?: boolean;
  locations: WarehouseLocation[];
  source?: string;
  migrationRequired?: boolean;
  updatedAt?: string | null;
}

export interface InventoryVariantRow {
  productSlug?: string;
  productName?: string | null;
  size?: string;
  channel?: "case" | "box" | string;
  onHand?: number;
  reserved?: number;
  incoming?: number;
  availableFinite?: number | null;
  reorderThreshold?: number | null;
  track?: boolean;
  active?: boolean;
  boxesPerCase?: number;
  availableIntactCases?: number | null;
  availableLooseBoxes?: number | null;
  availableBoxesEquivalent?: number | null;
}

export interface IncomingInventoryBatch {
  id?: string;
  batch_name?: string;
  supplier?: string | null;
  po_number?: string | null;
  container_number?: string | null;
  eta_date?: string | null;
  status?: string;
  notes?: string | null;
}

export interface IncomingInventoryLine {
  id?: string;
  batch_id?: string;
  product_slug?: string;
  size?: string;
  expected_cases?: number;
  expected_boxes?: number;
}

export interface IncomingInventoryPayload {
  rows?: Array<{ batch?: IncomingInventoryBatch; lines?: IncomingInventoryLine[] }>;
  summary?: { incomingCases?: number; incomingBoxes?: number };
}

export interface InventoryMovementRow {
  id?: string | number;
  createdAt?: string;
  created_at?: string;
  productSlug?: string;
  product_slug?: string;
  size?: string;
  channel?: string;
  deltaOnHand?: number;
  delta_on_hand?: number;
  deltaReserved?: number;
  delta_reserved?: number;
  reason?: string;
  adminUser?: string;
  admin_user?: string;
}

export interface InventoryDashboardResponse {
  summary?: {
    onHandTotal?: number;
    availableTotal?: number;
    reservedTotal?: number;
    incomingTotal?: number;
    lowStockCount?: number;
    outOfStockCount?: number;
  };
  variants?: InventoryVariantRow[];
  movements?: InventoryMovementRow[];
  shipments?: unknown[];
  incomingInventory?: IncomingInventoryPayload;
}

export interface MarketplaceOrderLine {
  id?: string;
  marketplace_order_id?: string;
  product_slug?: string;
  size?: string;
  quantity_cases?: number;
  quantity_boxes?: number;
  unit_type?: "case" | "box";
  unit_sale_price_cents?: number;
  unit_cost_cents?: number;
  line_revenue_cents?: number;
  line_cost_cents?: number;
}

export interface MarketplaceOrder {
  id?: string;
  marketplace?: "amazon" | "walmart" | string;
  external_order_id?: string;
  status?: "new" | "packed" | "shipped" | "cancelled" | string;
  sold_at?: string | null;
  packed_at?: string | null;
  shipped_at?: string | null;
  notes?: string | null;
  currency?: string;
  merchandise_subtotal_cents?: number;
  shipping_charged_cents?: number;
  discount_cents?: number;
  tax_collected_cents?: number;
  marketplace_fee_cents?: number;
  payment_processing_fee_cents?: number;
  shipping_cost_cents?: number;
  other_cost_cents?: number;
  refund_cents?: number;
  net_payout_cents?: number | null;
  financial_status?: "estimated" | "complete" | "partial_refund" | "refunded" | string;
  lines?: MarketplaceOrderLine[];
}

export interface MarketplaceOrdersResponse { orders?: MarketplaceOrder[] }

export interface TaxSummaryRow {
  month?: string;
  state?: string;
  taxable_revenue?: number;
  tax_collected?: number;
  total_orders?: number;
}

export interface TaxSummaryResponse {
  generated_at?: string;
  currency?: string;
  amounts_in?: string;
  note?: string;
  summary?: TaxSummaryRow[];
}

export interface ManualOrderAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface AddressVerificationResponse {
  verified: boolean;
  message?: string;
  normalizedAddress?: ManualOrderAddress | null;
  addressSuggestion?: ManualOrderAddress | null;
  fieldErrors?: Record<string, string>;
  addressValidation?: {
    code?: string;
    messages?: string[];
  } | null;
}

export interface ManualOrderItem {
  slug: string;
  bundleLines?: Array<{ id: string; qty: number }>;
  quantities?: Record<string, number>;
  boxQuantities?: Record<string, number>;
}

export interface ManualOrderEstimateRequest {
  name?: string;
  email?: string;
  phone?: string;
  address: ManualOrderAddress;
  items: ManualOrderItem[];
  fulfillmentMethod: "local_delivery" | "pickup" | "carrier" | "b2b_shipping";
  manualB2bShippingCents?: number;
  localDeliveryNote?: string;
  selectedShippingRateObjectId?: string;
  selectedShippingServiceCode?: string;
  selectedShippingServiceLabel?: string;
  selectedShippingProvider?: string;
  selectedShippingAmountCents?: number;
  selectedShippingParcelCount?: number;
  selectedShippingResidentialSurchargeCents?: number;
  manualDiscountType?: "none" | "percent" | "amount";
  manualDiscountValue?: number;
  quoteToken?: string;
}

export interface ManualOrderShippingRateOption {
  id?: string;
  provider?: string;
  serviceCode?: string;
  serviceLabel?: string;
  amountCents?: number;
  amountFormatted?: string;
  totalAmountCents?: number;
  totalAmountFormatted?: string;
  bufferCents?: number;
  bufferFormatted?: string;
  parcelCount?: number;
  estimatedDays?: number | null;
  residentialSurchargeCents?: number;
  residentialSurchargeFormatted?: string;
}

export interface ManualOrderQuoteResponse {
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
  totalCents?: number;
  merchandiseDiscountCents?: number;
  merchandiseDiscountFormatted?: string;
  originalMerchandiseSubtotalCents?: number;
  originalMerchandiseSubtotalFormatted?: string;
  subtotalFormatted?: string;
  shippingFormatted?: string;
  taxFormatted?: string;
  totalFormatted?: string;
  canCheckout?: boolean;
  userFacingError?: string | null;
  shippingRateOptions?: ManualOrderShippingRateOption[];
  warnings?: string[];
  quoteToken?: string;
  volumePricingApplied?: boolean;
  volumePricingSavingsCents?: number;
  freeDelivery?: {
    active?: boolean;
    eligible?: boolean;
    applied?: boolean;
    reason?: string;
    postalCode?: string | null;
    minimumSubtotalCents?: number;
    minimumSubtotalFormatted?: string;
    amountRemainingCents?: number;
    amountRemainingFormatted?: string;
    message?: string | null;
  };
}

export interface ManualOrderCreateRequest extends ManualOrderEstimateRequest {
  paymentFlow: "square_payment_link" | "pay_later";
  manualPaymentMethod?: "arrival_payment_link" | null;
  shipmentDate?: string | null;
  preserveExistingDiscountCode?: boolean;
}

export interface ManualOrderCreateResponse {
  orderId?: string;
  orderRef?: string;
  totalFormatted?: string;
  order_status?: string;
}

export interface ManualOrderDraftResponse {
  order?: Record<string, unknown>;
}

export interface ManualOrderSendLinkResponse {
  ok?: boolean;
  checkoutUrl?: string;
  emailed?: boolean;
  warning?: string;
  error?: string;
}

export interface AdminOrderShippoActionResponse {
  ok?: boolean;
  order?: Record<string, unknown>;
  shipment?: Record<string, unknown>;
  purchase?: Record<string, unknown>;
  error?: string;
  warning?: string;
}

export interface AdminOrderShipFromDisplayResponse {
  ok?: boolean;
  lines?: string[];
  formatted?: string;
  error?: string;
}

export interface PackingPlanParcel {
  length?: string;
  width?: string;
  height?: string;
  weight?: string;
  distance_unit?: string;
  mass_unit?: string;
  metadata?: string;
}

export interface PackingPlanContent {
  parcelIndex?: number;
  type?: string;
  cartonId?: string;
  retailBoxCount?: number;
  slug?: string;
  size?: string;
  source?: string;
  contents?: Array<{ slug?: string; size?: string; source?: string }>;
}

export interface PackingPlanSummary {
  planId?: string | null;
  source?: string | null;
  parcelCount?: number;
  selectedAt?: string | null;
  selectedBy?: string | null;
  parcels?: PackingPlanParcel[];
  parcelContents?: PackingPlanContent[];
  fulfillmentUnits?: Array<Record<string, unknown>>;
}

export interface AdminOrderPackingPlanResponse {
  ok?: boolean;
  action?: "preview" | "save" | "clear";
  order?: Record<string, unknown>;
  packingPlan?: PackingPlanSummary | null;
  selectedPackingPlan?: PackingPlanSummary | null;
  error?: string;
}

export interface PackagingDimensions {
  length?: number | string;
  width?: number | string;
  height?: number | string;
  weightLb?: number | string;
}

export interface PackagingCarton {
  id?: string;
  label?: string;
  compatibilityGroup?: string;
  inner?: PackagingDimensions;
  outer?: PackagingDimensions;
  maxRetailBox?: PackagingDimensions;
  tareWeightLb?: number | string;
  costCents?: number | string;
  maxWeightLb?: number | string;
  maxRetailBoxes?: number | string;
  packageType?: string;
  packingMaterial?: string;
  packingInstructions?: string;
}

export interface PackagingProductSizeProfile {
  retailUnit?: PackagingDimensions;
  factoryCase?: PackagingDimensions;
}

export interface PackagingProductProfile {
  compatibilityGroup?: string;
  boxesPerFactoryCase?: number | string;
  factoryCaseShipAsIs?: boolean;
  sizes?: Record<string, PackagingProductSizeProfile>;
}

export interface PackagingConfig {
  $schema?: string;
  description?: string;
  distanceUnit?: string;
  massUnit?: string;
  defaults?: Record<string, unknown>;
  shippingCartons?: PackagingCarton[];
  products?: Record<string, PackagingProductProfile>;
}

export interface PackagingConfigResponse {
  ok?: boolean;
  config?: PackagingConfig;
  error?: string;
  source?: "supabase" | "bundled_file" | "bundled_default";
  migrationRequired?: boolean;
  updatedAt?: string | null;
}

export interface BundleCatalogBundle {
  id: string;
  label: string;
  kind: "box" | "case";
  units: number;
  priceCents: number;
  hardinPriceCents?: number;
  cogsCents?: number;
  builtInShippingTotalCents?: number;
  expectedProfitCents?: number;
  badge?: string;
  active?: boolean;
}

export interface VolumePricingRule {
  active: boolean;
  minCases: number;
  pricePerCaseCents: number;
  allowDiscountStacking: boolean;
}

export interface BundleCatalog {
  $schema?: string;
  products: Array<{ slug: string; name: string; bundles: BundleCatalogBundle[]; volumePricing?: VolumePricingRule }>;
}

export interface BundleCatalogResponse {
  ok?: boolean;
  catalog?: BundleCatalog;
  source?: "supabase" | "bundled_file" | "bundled_default";
  migrationRequired?: boolean;
  updatedAt?: string | null;
}

interface AdminOrderShippoPreviewResponse {
  ok?: boolean;
  order?: Record<string, unknown>;
  preview?: {
    recommendedPackingPlan?: PackingPlanSummary | null;
    recommendedPackingPlanError?: string | null;
  };
  error?: string;
}

async function fetchJson<T>(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, { headers });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      (typeof data.error === "string" && data.error) ||
      (typeof data.message === "string" && data.message) ||
      `Request failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

async function postJson<T>(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      (typeof data.error === "string" && data.error) ||
      (typeof data.message === "string" && data.message) ||
      `Request failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

export function fetchSummary(preset: SummaryPreset, token?: string, channel = "all") {
  return fetchJson<SummaryResponse>(`/api/admin-summary?preset=${encodeURIComponent(preset)}&channel=${encodeURIComponent(channel)}`, token);
}

export function fetchNexusSummary(token?: string) {
  return fetchJson<NexusSummaryResponse>("/api/nexus-summary", token);
}

export function fetchDiscountCodes(token?: string) {
  return fetchJson<DiscountCodesResponse>("/api/admin-discount-codes", token);
}

export function createDiscountCode(body: { mode: "random" | "manual"; code?: string; percentOff: number }, token?: string) {
  return postJson<CreateDiscountCodeResponse>("/api/admin-discount-codes", body, token);
}

export function fetchShippingHealth(token?: string) {
  return fetchJson<ShippingHealthResponse>("/api/admin-shipping-health", token);
}

export function fetchPaymentHealth(token?: string) {
  return fetchJson<PaymentHealthResponse>("/api/admin-payment-health", token);
}

export type PaymentFeeProfile = { label: string; percentBps: number; fixedCents: number };
export type PaymentFeeConfig = {
  version: number;
  currency: "USD";
  profiles: { online: PaymentFeeProfile; cardPresent: PaymentFeeProfile; noFee: PaymentFeeProfile };
};
export type PaymentFeeConfigResponse = { config: PaymentFeeConfig; source: string; migrationRequired?: boolean; updatedAt?: string | null };

export function fetchPaymentFeeConfig(token?: string) {
  return fetchJson<PaymentFeeConfigResponse>("/api/admin-payment-fee-config", token);
}

export function savePaymentFeeConfig(config: PaymentFeeConfig, token?: string) {
  return postJson<PaymentFeeConfigResponse>("/api/admin-payment-fee-config", { config }, token);
}

export type FreeDeliveryConfig = {
  version: number;
  active: boolean;
  state: string;
  postalCodes: string[];
  minimumSubtotalCents: number;
  /** @deprecated Compatibility only; whole-order subtotal controls eligibility. */
  productMinimumsCents?: Record<string, number>;
};
export type FreeDeliveryConfigResponse = { config: FreeDeliveryConfig; source: string; migrationRequired?: boolean; updatedAt?: string | null };

export function fetchFreeDeliveryConfig(token?: string) {
  return fetchJson<FreeDeliveryConfigResponse>("/api/admin-free-delivery-config", token);
}

export function saveFreeDeliveryConfig(config: FreeDeliveryConfig, token?: string) {
  return postJson<FreeDeliveryConfigResponse>("/api/admin-free-delivery-config", { config }, token);
}

export function fetchInventoryDashboard(token?: string) {
  return fetchJson<InventoryDashboardResponse>("/api/admin-inventory", token);
}

export function postInventoryAction<T = Record<string, unknown>>(body: unknown, token?: string) {
  return postJson<T>("/api/admin-inventory", body, token);
}

export function fetchMarketplaceOrders(token?: string) {
  return fetchJson<MarketplaceOrdersResponse>("/api/admin-marketplace-orders", token);
}

export function postMarketplaceOrderAction<T = Record<string, unknown>>(body: unknown, token?: string) {
  return postJson<T>("/api/admin-marketplace-orders", body, token);
}

export function fetchPackagingConfig(token?: string) {
  return fetchJson<PackagingConfigResponse>("/api/admin-packaging-config", token);
}

export function savePackagingConfig(config: PackagingConfig, token?: string) {
  return postJson<PackagingConfigResponse>("/api/admin-packaging-config", { config }, token);
}

export function fetchBundleCatalog(token?: string) {
  return fetchJson<BundleCatalogResponse>("/api/admin-bundle-config", token);
}

export function saveBundleCatalog(catalog: BundleCatalog, token?: string) {
  return postJson<BundleCatalogResponse>("/api/admin-bundle-config", { catalog }, token);
}

export function fetchWarehouseConfig(token?: string) {
  return fetchJson<WarehouseConfigResponse>("/api/admin-warehouse-config", token);
}

export function saveWarehouseConfig(locations: WarehouseLocation[], token?: string) {
  return postJson<WarehouseConfigResponse>("/api/admin-warehouse-config", { locations }, token);
}

export function fetchTaxSummary(token?: string) {
  return fetchJson<TaxSummaryResponse>("/api/tax-summary", token);
}

export function estimateManualOrder(body: ManualOrderEstimateRequest, token?: string) {
  return postJson<ManualOrderQuoteResponse>("/api/admin-manual-order-estimate", body, token);
}

export function verifyManualOrderAddress(address: ManualOrderAddress, token?: string) {
  return postJson<AddressVerificationResponse>("/api/admin-address-verify", { address }, token);
}

export function createManualOrder(body: ManualOrderCreateRequest, token?: string) {
  return postJson<ManualOrderCreateResponse>("/api/admin-manual-order-create", body, token);
}

export function fetchManualOrderDraft(orderId: string, token?: string) {
  return fetchJson<ManualOrderDraftResponse>(`/api/admin-manual-order-drafts?id=${encodeURIComponent(orderId)}`, token);
}

export function prepareManualOrderEdit(orderId: string, token?: string) {
  return postJson<ManualOrderDraftResponse>("/api/admin-manual-order-prepare-edit", { orderId }, token);
}

export function updateManualOrderDraft(
  body: ManualOrderCreateRequest & { orderId: string },
  token?: string,
) {
  return postJson<ManualOrderCreateResponse>("/api/admin-manual-order-update-draft", body, token);
}

export function sendManualOrderLink(
  body: { orderId: string; shipmentDate?: string | null; allowPayLaterLink?: boolean } & Partial<ManualOrderEstimateRequest>,
  token?: string,
) {
  return postJson<ManualOrderSendLinkResponse>("/api/admin-manual-order-send-link", body, token);
}

export function syncOrderToShippo(orderId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-shippo-sync", { orderId }, token);
}

export function fetchOrderShipFromDisplay(orderId: string, token?: string) {
  return postJson<AdminOrderShipFromDisplayResponse>("/api/admin-order-ship-from-display", { orderId }, token);
}

export function purchaseOrderShippoLabel(orderId: string, rateObjectId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-shippo-purchase-label", { orderId, rateObjectId }, token);
}

export function purchaseOrderShippoAllLabels(orderId: string, rateObjectId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-shippo-buy-all-labels", { orderId, rateObjectId }, token);
}

export function notifyBuyerShipping(orderId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-buyer-shipping-notify", { orderId }, token);
}

export function confirmOrderProductShipped(orderId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-confirm-shipped", { orderId }, token);
}

export function cancelAndRefundOrder(orderId: string, reason: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse & { complete?: boolean; warning?: string | null }>(
    "/api/admin-order-cancel",
    { orderId, reason },
    token,
  );
}

export function checkCancelledOrderRefundStatus(orderId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse & { complete?: boolean; warning?: string | null }>(
    "/api/admin-order-cancel-status",
    { orderId },
    token,
  );
}

export function sendCancelledOrderRefundEmail(orderId: string, requestId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse & { square?: { action?: string; status?: string } }>(
    "/api/admin-order-cancellation-email",
    { orderId, requestId },
    token,
  );
}

export function completeOrderHandoff(orderId: string, token?: string) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-fulfillment-handoff", { orderId }, token);
}

export interface ExternalFulfillmentFile {
  name: string;
  base64: string;
}

export function saveOrderExternalFulfillment(
  body: {
    orderId: string;
    carrier: string;
    service?: string;
    trackingNumber: string;
    shippedDate?: string | null;
    labelCostCents?: number | null;
    labelFiles?: ExternalFulfillmentFile[];
    packingSlipFiles?: ExternalFulfillmentFile[];
  },
  token?: string,
) {
  return postJson<AdminOrderShippoActionResponse>("/api/admin-order-external-fulfillment-save", body, token);
}

export function updateOrderPackingPlan(orderId: string, action: "preview" | "save" | "clear", token?: string) {
  return postJson<AdminOrderPackingPlanResponse>("/api/admin-order-packing-plan", { orderId, action }, token);
}

export async function previewOrderPackingPlan(orderId: string, token?: string) {
  try {
    return await updateOrderPackingPlan(orderId, "preview", token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 405) {
      throw error;
    }
  }

  const fallback = await postJson<AdminOrderShippoPreviewResponse>("/api/admin-order-shippo-preview", { orderId }, token);
  const packingPlan = fallback.preview?.recommendedPackingPlan || null;
  const packingPlanError = fallback.preview?.recommendedPackingPlanError || "";
  if (packingPlanError) {
    throw new ApiError(packingPlanError, 400, { error: packingPlanError });
  }
  return {
    ok: true,
    action: "preview" as const,
    order: fallback.order,
    packingPlan,
    selectedPackingPlan: null,
  };
}
