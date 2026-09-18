import { Resend } from "resend";
import { assertPublicApiRequestAllowed } from "../lib/public-api-guard.js";

const fields = { name: 150, company: 200, email: 254, phone: 80, org_type: 100, products: 300, quantity: 300, message: 5000 };
export function createContactHandler({ env = process.env, send = async (key, message) => new Resend(key).emails.send(message) } = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
    try {
      assertPublicApiRequestAllowed(req, { name: "contact-inquiry", limit: 5, windowMs: 600_000, maxBodyBytes: 16_000 });
      if (!String(req.headers?.["content-type"] || "").startsWith("application/json")) return res.status(415).json({ error: "JSON required." });
      const raw = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return res.status(400).json({ error: "Invalid inquiry." });
      if (Buffer.byteLength(JSON.stringify(raw)) > 16_000) return res.status(413).json({ error: "Inquiry too long." });
      if (raw.website) return res.status(200).json({ sent: true });
      const data = {};
      for (const [key, max] of Object.entries(fields)) {
        if (raw[key] != null && typeof raw[key] !== "string") return res.status(400).json({ error: "Invalid inquiry field." });
        data[key] = (raw[key] || "").trim();
        if (data[key].length > max) return res.status(400).json({ error: "Please shorten your inquiry." });
      }
      if (["name", "company", "email", "org_type", "products", "message"].some(key => !data[key]) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return res.status(400).json({ error: "Please complete all required fields with a valid email address." });
      // Dedicated configuration: never fall back to live order-email credentials.
      const key = env.CONTACT_RESEND_API_KEY?.trim();
      const from = env.CONTACT_FROM?.trim();
      const to = env.CONTACT_TO?.trim();
      if (!key || !from || !to) return res.status(503).json({ error: "Inquiry delivery is not enabled yet. Please contact sales@saigoods.com directly." });
      const { data: receipt, error } = await send(key, { from, to: [to], replyTo: data.email, subject: "New SAI Goods business inquiry", text: Object.entries(data).map(([key, value]) => `${key}: ${value}`).join("\n\n") });
      if (error || !receipt?.id) return res.status(502).json({ error: "We could not send your inquiry. Your details are still here; please try again." });
      return res.status(200).json({ sent: true });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : error.statusCode || 502;
      return res.status(status).json({ error: status === 429 ? "Too many inquiries. Please wait and try again." : "Unable to send your inquiry. Please try again." });
    }
  };
}
export default createContactHandler();
