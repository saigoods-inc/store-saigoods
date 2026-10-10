import { manualPaymentEmailSubject } from "./manual-payment-email-subject.js";
const LABELS = {
  sent: 'Sent · awaiting delivery confirmation',
  delivered: 'Delivered to recipient’s mail server',
  bounced: 'Bounced · check the recipient address',
  failed: 'Email failed',
  suppressed: 'Email suppressed · not delivered',
  complained: 'Recipient reported this email as spam',
  delivery_delayed: 'Delivery delayed',
  queued: 'Email queued',
  scheduled: 'Email scheduled',
  unknown: 'Delivery status unavailable for this order',
  unavailable: 'Email provider status temporarily unavailable',
  not_sent: 'Payment email not sent',
};
const result = (status) => ({ status, label: LABELS[status], sentAt: null });
const normalizedEmail = (value) => String(value || '').trim().toLowerCase();

/** Read-only, bounded provider lookup. No order mutations or email sends. */
export async function getPaymentEmailDeliveryStatus(order, options = {}) {
  const subject = manualPaymentEmailSubject(order?.order_ref);
  const recipient = normalizedEmail(order?.customer_email);
  const createdAt = Date.parse(order?.created_at);
  if (!order?.order_ref || !recipient || !Number.isFinite(createdAt)) return result('unknown');
  const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
  if (!options.listEmails && !String(apiKey || '').trim()) return { ...result('unavailable'), label: 'Email delivery lookup is not configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const listEmails = options.listEmails || (async ({ limit, after }) => {
    const url = new URL('https://api.resend.com/emails');
    url.searchParams.set('limit', String(limit));
    if (after) url.searchParams.set('after', after);
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${String(apiKey).trim()}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error('Email provider lookup unavailable');
      error.readAccessDenied = response.status === 401 || response.status === 403;
      throw error;
    }
    return response.json();
  });
  try {
    let after;
    for (let page = 0; page < 5; page++) {
      const response = await listEmails({ limit: 100, ...(after ? { after } : {}) });
      if (!Array.isArray(response?.data) || typeof response.has_more !== 'boolean') throw new Error('Invalid email provider response');
      const matches = response.data.filter((email) => {
        const sentAt = Date.parse(email.created_at);
        const recipients = Array.isArray(email.to) ? email.to : [email.to];
        return email.subject === subject && recipients.some((to) => normalizedEmail(to) === recipient) && Number.isFinite(sentAt) && sentAt >= createdAt;
      });
      if (matches.length) {
        // Resend pages newest first; select the newest attempt within this page.
        const latest = matches.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
        const event = String(latest.last_event || '').replace(/^email\./, '');
        const status = ['opened', 'clicked'].includes(event) ? 'delivered' : Object.hasOwn(LABELS, event) && !['not_sent', 'unavailable'].includes(event) ? event : 'unknown';
        return { ...result(status), sentAt: new Date(latest.created_at).toISOString(), ...(typeof latest.id === 'string' ? { emailId: latest.id } : {}) };
      }
      const olderThanOrder = response.data.length > 0 && response.data.every((email) => {
        const timestamp = Date.parse(email.created_at);
        return Number.isFinite(timestamp) && timestamp < createdAt;
      });
      if (!response.has_more || olderThanOrder) {
        return result(order.payment_link_url || order.payment_link_id || order.payment_link_sent_at ? 'unknown' : 'not_sent');
      }
      const cursor = response.data.at(-1)?.id;
      if (!cursor || cursor === after) return result('unknown');
      after = cursor;
    }
    return result('unknown');
  } catch (error) {
    if (error?.readAccessDenied) return { ...result('unavailable'), label: 'Email delivery lookup requires provider read access' };
    // Provider responses may contain customer data or credentials; never forward them.
    return result('unavailable');
  } finally {
    clearTimeout(timeout);
  }
}
