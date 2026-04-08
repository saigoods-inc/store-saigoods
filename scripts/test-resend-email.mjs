#!/usr/bin/env node
/**
 * Send a one-off test using your real Resend template (same HTML as checkout).
 *
 * Usage:
 *   npm run test:resend -- you@example.com
 *
 * Requires in .env: RESEND_API_KEY, RESEND_FROM (verified domain in Resend).
 * On Resend’s free tier you can usually only send to your own verified address.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import { buildOrderConfirmationHtml, normalizeResendFrom } from "../lib/resend-order-confirmation.js";

const root = dirname(fileURLToPath(new URL(import.meta.url)));
const projectRoot = join(root, "..");

function loadDotEnv() {
  try {
    const raw = readFileSync(join(projectRoot, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const i = trimmed.indexOf("=");
      if (i === -1) {
        continue;
      }
      const key = trimmed.slice(0, i).trim();
      const value = trimmed.slice(i + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // no .env
  }
}

loadDotEnv();

const to = process.argv[2];
if (!to || !String(to).includes("@")) {
  console.error("Usage: npm run test:resend -- <your-email@example.com>");
  process.exit(1);
}

const key = process.env.RESEND_API_KEY?.trim();
const from = normalizeResendFrom(process.env.RESEND_FROM);
if (!key || !from) {
  console.error("Missing RESEND_API_KEY or RESEND_FROM in .env");
  process.exit(1);
}

const html = buildOrderConfirmationHtml({
  pending: {
    id: "test-internal-id",
    order_ref: "SAI-TEST",
    created_at: new Date().toISOString(),
  },
  quote: {
    totalFormatted: "$0.00",
    items: [
      {
        name: "Test line — Resend is working",
        slug: "test",
        lineCases: 1,
        lineBoxCount: 0,
      },
    ],
  },
  customerName: "Friend",
});

const resend = new Resend(key);
const { data, error } = await resend.emails.send({
  from,
  to: [String(to).trim()],
  subject: "SAI Goods — Resend test (order template)",
  html,
});

if (error) {
  console.error("Resend API error:", error);
  if (error?.statusCode === 422 && String(error?.message || "").includes("from")) {
    console.error("");
    console.error("Fix RESEND_FROM in .env. Valid examples (no stray quotes):");
    console.error("  RESEND_FROM=sales@saigoods.com");
    console.error("  RESEND_FROM=SAI Goods <sales@saigoods.com>");
    console.error("If you used quotes around the value, they are stripped automatically now — check for typos or missing < > around the address.");
    console.error("After normalize, from is:", JSON.stringify(from));
  }
  process.exit(1);
}

console.log("Email sent. Resend message id:", data?.id ?? "(none)");
console.log("Check inbox (and spam) for:", to);
