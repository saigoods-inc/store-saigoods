import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTaxExemptionToQuote,
  approvedTaxExemptionSnapshot,
  issueTaxExemptionCertificateReference,
  parseTaxExemptionCertificate,
  parseTaxExemptionDetails,
  verifyTaxExemptionCertificateReference,
} from "./admin-tax-exemption.js";

const request = {
  requested: true,
  exemptionType: "organization_own_use",
  jurisdiction: "TN",
  certificateNumber: "TN-EXEMPT-1",
  effectiveDate: "2026-01-01",
  expirationDate: "2027-01-01",
  internalNote: "Hospital purchasing gloves for organizational use.",
  documentReviewed: true,
  certificateSelected: true,
};

test("tax exemption is opt-in and requires review, certificate, and matching jurisdiction", () => {
  assert.equal(parseTaxExemptionDetails(null), null);
  assert.throws(
    () => parseTaxExemptionDetails({ ...request, documentReviewed: false }, { shippingAddress: { state: "TN" }, customer: { name: "Buyer" } }),
    /reviewed/i,
  );
  assert.throws(
    () => parseTaxExemptionDetails({ ...request, certificateSelected: false }, { shippingAddress: { state: "TN" }, customer: { name: "Buyer" } }),
    /certificate/i,
  );
  assert.throws(
    () => parseTaxExemptionDetails(request, { shippingAddress: { state: "KY" }, customer: { name: "Buyer" } }),
    /match the current shipping state/i,
  );
  assert.equal(
    parseTaxExemptionDetails(request, { shippingAddress: { state: "TN" }, customer: { name: "Buyer" } })?.jurisdiction,
    "TN",
  );
});

test("certificate parser verifies size, extension, and file signature", () => {
  const bytes = Buffer.from("%PDF-1.7\nminimal test certificate\n%%EOF", "utf8");
  const certificate = parseTaxExemptionCertificate({
    filename: "buyer-certificate.pdf",
    contentType: "application/pdf",
    contentBase64: bytes.toString("base64"),
    sizeBytes: bytes.length,
  });
  assert.equal(certificate.contentType, "application/pdf");
  assert.equal(certificate.sizeBytes, bytes.length);
  assert.match(certificate.sha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () => parseTaxExemptionCertificate({ filename: "buyer-certificate.jpg", contentType: "application/pdf", contentBase64: bytes.toString("base64"), sizeBytes: bytes.length }),
    /filename does not match/i,
  );
});

test("approved exemption removes only tax and records the excluded amount", () => {
  const details = parseTaxExemptionDetails(request, { shippingAddress: { state: "TN" }, customer: { name: "Buyer" } });
  const approved = approvedTaxExemptionSnapshot({
    details,
    certificate: { storagePath: "tax-exempt/id/cert.pdf", filename: "cert.pdf", contentType: "application/pdf", sizeBytes: 50, sha256: "a".repeat(64) },
    actor: { kind: "user", email: "admin@example.com", id: "admin-1" },
    customer: { name: "Buyer", email: "buyer@example.com" },
    shippingAddress: { line1: "1 Main St", city: "Nashville", state: "TN", postalCode: "37201", country: "US" },
  });
  const quote = applyTaxExemptionToQuote({ subtotalCents: 10_000, shippingCents: 1_000, taxCents: 925, totalCents: 11_925 }, approved);
  assert.equal(quote.taxCents, 0);
  assert.equal(quote.totalCents, 11_000);
  assert.equal(quote.taxExemption.taxExcludedCents, 925);
  assert.equal(quote.taxExemption.approvedBy, "admin@example.com");
});

test("saved certificate references are signed and bound to the existing order certificate", () => {
  const previous = process.env.TAX_EXEMPTION_REFERENCE_SECRET;
  process.env.TAX_EXEMPTION_REFERENCE_SECRET = "test-only-reference-secret";
  try {
    const certificate = { storagePath: "tax-exempt/id/cert.pdf", filename: "cert.pdf", contentType: "application/pdf", sizeBytes: 50, sha256: "b".repeat(64) };
    const reference = issueTaxExemptionCertificateReference({ status: "approved", certificate });
    assert.ok(reference);
    assert.deepEqual(verifyTaxExemptionCertificateReference(reference, { status: "approved", certificate }), certificate);
    assert.throws(
      () => verifyTaxExemptionCertificateReference(reference, { status: "approved", certificate: { ...certificate, storagePath: "tax-exempt/other/cert.pdf" } }),
      /does not belong to this order/i,
    );
  } finally {
    if (previous === undefined) delete process.env.TAX_EXEMPTION_REFERENCE_SECRET;
    else process.env.TAX_EXEMPTION_REFERENCE_SECRET = previous;
  }
});
