export function formatUsdCents(cents: number | null | undefined) {
  const amount = Number(cents || 0) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${read("day")} ${read("month")}, ${read("year")}, ${read("hour")}:${read("minute")}`;
}

export function formatShortDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatBucketLabel(value: string | null | undefined, mode: "day" | "week" | undefined) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  if (mode === "week") {
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}-${end.getUTCMonth() + 1}/${end.getUTCDate()}`;
  }
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

export function signedCurrencyLabel(cents: number | null | undefined) {
  const amount = Number(cents || 0);
  const abs = formatUsdCents(Math.abs(amount));
  return `${amount >= 0 ? "+" : "-"}${abs}`;
}

export function percentDelta(current: number | null | undefined, previous: number | null | undefined) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (before <= 0) return null;
  return Math.round((Math.abs(now - before) / before) * 1000) / 10;
}

export function stateName(code: string | null | undefined) {
  const lookup: Record<string, string> = {
    AL: "Alabama",
    AK: "Alaska",
    AZ: "Arizona",
    AR: "Arkansas",
    CA: "California",
    CO: "Colorado",
    CT: "Connecticut",
    DE: "Delaware",
    FL: "Florida",
    GA: "Georgia",
    HI: "Hawaii",
    ID: "Idaho",
    IL: "Illinois",
    IN: "Indiana",
    IA: "Iowa",
    KS: "Kansas",
    KY: "Kentucky",
    LA: "Louisiana",
    ME: "Maine",
    MD: "Maryland",
    MA: "Massachusetts",
    MI: "Michigan",
    MN: "Minnesota",
    MS: "Mississippi",
    MO: "Missouri",
    MT: "Montana",
    NE: "Nebraska",
    NV: "Nevada",
    NH: "New Hampshire",
    NJ: "New Jersey",
    NM: "New Mexico",
    NY: "New York",
    NC: "North Carolina",
    ND: "North Dakota",
    OH: "Ohio",
    OK: "Oklahoma",
    OR: "Oregon",
    PA: "Pennsylvania",
    RI: "Rhode Island",
    SC: "South Carolina",
    SD: "South Dakota",
    TN: "Tennessee",
    TX: "Texas",
    UT: "Utah",
    VT: "Vermont",
    VA: "Virginia",
    WA: "Washington",
    WV: "West Virginia",
    WI: "Wisconsin",
    WY: "Wyoming",
  };

  const key = String(code || "").trim().toUpperCase();
  return lookup[key] || key || "-";
}
