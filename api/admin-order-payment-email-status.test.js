import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentEmailStatusHandler } from './admin-order-payment-email-status.js';
function response() {
  return { headers: {}, statusCode: 200, body: null, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
test('authorizes before reading any customer order', async () => {
  let reads = 0;
  const handler = createPaymentEmailStatusHandler({ authorize: async () => { throw new Error('private'); }, getOrder: async () => { reads++; } });
  const res = response();
  await handler({ method: 'POST', body: { orderId: '140' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(reads, 0);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.ok(!JSON.stringify(res.body).includes('private'));
});
test('gets recipient and reference from saved order, never request values', async () => {
  const order = { id: 'test', order_source: 'manual', payment_flow: 'pay_later', customer_email: 'saved@example.test' };
  const handler = createPaymentEmailStatusHandler({ authorize: async () => {}, getOrder: async (id) => { assert.equal(id, 'test'); return order; }, getStatus: async (value) => { assert.equal(value, order); return { status: 'delivered', label: 'Delivered', sentAt: '2026-10-10T00:00:00Z' }; } });
  const res = response();
  await handler({ method: 'POST', body: { orderId: 'test', customer_email: 'attacker@example.test' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'delivered');
});
for (const [name, saved, expected] of [['missing', null, 404], ['web', { order_source: 'web' }, 400]]) {
  test(`rejects ${name} orders before provider lookup`, async () => {
    const handler = createPaymentEmailStatusHandler({ authorize: async () => {}, getOrder: async () => saved, getStatus: async () => { assert.fail('must not read provider'); } });
    const res = response();
    await handler({ method: 'POST', body: { orderId: 'test' } }, res);
    assert.equal(res.statusCode, expected);
  });
}
test('rejects unsupported methods and missing IDs', async () => {
  const handler = createPaymentEmailStatusHandler({ authorize: async () => {}, getOrder: async () => assert.fail('must not read order') });
  for (const [req, code] of [[{ method: 'GET' }, 405], [{ method: 'POST', body: {} }, 400]]) {
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, code);
  }
});
test('unexpected database errors do not expose sensitive messages', async () => {
  const handler = createPaymentEmailStatusHandler({ authorize: async () => {}, getOrder: async () => { throw new Error('database secret'); } });
  const res = response();
  await handler({ method: 'POST', body: { orderId: 'test' } }, res);
  assert.equal(res.statusCode, 503);
  assert.ok(!JSON.stringify(res.body).includes('secret'));
});
