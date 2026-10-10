import test from 'node:test';
import assert from 'node:assert/strict';
import { getPaymentEmailDeliveryStatus } from './payment-email-delivery-status.js';
const order = { order_ref: 'SAI-TEST', customer_email: 'Buyer@Example.com', created_at: '2026-10-01T00:00:00Z', payment_link_url: 'https://example.test/pay' };
const email = (overrides = {}) => ({ id: 'email-1', subject: 'Your SAI Goods order is ready — SAI-TEST', to: ['buyer@example.com'], created_at: '2026-10-02T00:00:00Z', last_event: 'delivered', ...overrides });
const lookup = (data, value = order) => getPaymentEmailDeliveryStatus(value, { listEmails: async () => ({ data, has_more: false }) });
test('matches exact order, normalized recipient and creation time, returning only safe fields', async () => {
  const result = await lookup([email({ subject: 'Your SAI Goods order is ready — SAI-TEST2' }), email({ to: ['someone@example.com'] }), email({ created_at: '2026-09-30T00:00:00Z' }), email({ to: [' BUYER@example.com '], html: 'private' })]);
  assert.deepEqual(result, { status: 'delivered', label: 'Delivered to recipient’s mail server', sentAt: '2026-10-02T00:00:00.000Z', emailId: 'email-1' });
});
test('latest attempt wins even if an older attempt delivered', async () => {
  assert.equal((await lookup([email(), email({ id: 'new', created_at: '2026-10-03T00:00:00Z', last_event: 'bounced' })])).status, 'bounced');
});
test('searches additional pages using the provider cursor', async () => {
  const calls = [];
  const result = await getPaymentEmailDeliveryStatus(order, { listEmails: async (options) => { calls.push(options); return calls.length === 1 ? { data: [email({ id: 'cursor', to: ['other@example.com'] })], has_more: true } : { data: [email()], has_more: false }; } });
  assert.equal(result.status, 'delivered');
  assert.deepEqual(calls, [{ limit: 100 }, { limit: 100, after: 'cursor' }]);
});
for (const event of ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'suppressed', 'complained', 'delivery_delayed', 'queued', 'scheduled']) {
  test(`maps ${event}`, async () => assert.equal((await lookup([email({ last_event: event })])).status, ['opened', 'clicked'].includes(event) ? 'delivered' : event));
}
test('unknown event is not falsely reported as sent', async () => assert.equal((await lookup([email({ last_event: 'new_event' })])).status, 'unknown'));
test('no match with a link remains unknown; no link and no history is not sent', async () => {
  assert.equal((await lookup([])).status, 'unknown');
  assert.equal((await lookup([], { ...order, payment_link_url: null })).status, 'not_sent');
});
test('bounds pagination and does not infer not sent from incomplete history', async () => {
  let calls = 0;
  const result = await getPaymentEmailDeliveryStatus({ ...order, payment_link_url: null }, { listEmails: async () => { calls++; return { data: [email({ id: `other-${calls}`, to: ['other@example.com'] })], has_more: true }; } });
  assert.equal(calls, 5);
  assert.equal(result.status, 'unknown');
});
test('provider error is sanitized and unavailable', async () => {
  const result = await getPaymentEmailDeliveryStatus(order, { listEmails: async () => { throw new Error('secret token email body'); } });
  assert.equal(result.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('missing key and malformed provider result return unavailable', async () => {
  assert.equal((await getPaymentEmailDeliveryStatus(order, { apiKey: '' })).status, 'unavailable');
  assert.equal((await getPaymentEmailDeliveryStatus(order, { listEmails: async () => ({ error: 'private' }) })).status, 'unavailable');
});
test('does not search provider pages entirely older than the order', async () => {
  let calls = 0;
  const status = await getPaymentEmailDeliveryStatus(order, { listEmails: async () => {
    calls++;
    return { data: [email({ id: `old-${calls}`, created_at: '2026-09-30T00:00:00Z' })], has_more: true };
  } });
  assert.equal(calls, 1);
  assert.equal(status.status, 'unknown');
});
