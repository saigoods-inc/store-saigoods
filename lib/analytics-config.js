const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

export function resolveAnalyticsConfigFromEnv(env = process.env) {
  const measurementId = String(env.GA4_MEASUREMENT_ID || "")
    .trim()
    .toUpperCase();

  if (!measurementId) {
    return { enabled: false, measurementId: null };
  }

  if (!GA4_MEASUREMENT_ID_PATTERN.test(measurementId)) {
    return { enabled: false, measurementId: null };
  }

  return { enabled: true, measurementId };
}
