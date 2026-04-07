/**
 * Protects reporting APIs. Set INTERNAL_REPORTS_SECRET in env; clients send:
 *   Authorization: Bearer <INTERNAL_REPORTS_SECRET>
 * If the secret is unset, routes are open (convenient for local dev only).
 */

export function assertReportsAuthorized(req) {
  const secret = process.env.INTERNAL_REPORTS_SECRET?.trim();
  if (!secret) {
    return;
  }

  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const expected = `Bearer ${secret}`;
  if (auth !== expected) {
    const err = new Error("Unauthorized.");
    err.statusCode = 401;
    throw err;
  }
}
