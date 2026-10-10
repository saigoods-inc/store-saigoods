import { assertReportsAuthorized } from '../lib/reports-auth.js';
import { getOrderByIdForService } from '../lib/orders.js';
import { getPaymentEmailDeliveryStatus } from '../lib/payment-email-delivery-status.js';

export function createPaymentEmailStatusHandler(deps = {}) {
  const authorize = deps.authorize || assertReportsAuthorized;
  const getOrder = deps.getOrder || getOrderByIdForService;
  const getStatus = deps.getStatus || getPaymentEmailDeliveryStatus;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    try {
      await authorize(req);
    } catch (error) {
      return res.status(error.statusCode === 403 ? 403 : 401).json({ error: 'Admin authorization required.' });
    }
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'Order ID is required.' });
    try {
      const order = await getOrder(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found.' });
      if (order.order_source !== 'manual') return res.status(400).json({ error: 'Payment email status is available for manual orders only.' });
      return res.status(200).json(await getStatus(order));
    } catch {
      return res.status(503).json({ error: 'Could not check payment email status.' });
    }
  };
}

export default createPaymentEmailStatusHandler();
