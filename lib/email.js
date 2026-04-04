import sgMail from "@sendgrid/mail";

const fromEmail = process.env.EMAIL_FROM;
const vendorEmail = process.env.VENDOR_NOTIFICATION_EMAIL;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

export async function sendCustomerEmail(order) {
  if (!process.env.SENDGRID_API_KEY || !fromEmail || !order.customer.email) {
    return;
  }

  const label = order.orderRef || order.id;

  const msg = {
    to: order.customer.email,
    from: fromEmail,
    subject: `Your SAI Goods order ${label}`,
    text: buildCustomerText(order),
  };

  try {
    await sgMail.send(msg);
  } catch (err) {
    console.error("sendCustomerEmail failed:", err);
  }
}

export async function sendVendorEmail(order) {
  if (!process.env.SENDGRID_API_KEY || !fromEmail || !vendorEmail) {
    return;
  }

  const label = order.orderRef || order.id;

  const msg = {
    to: vendorEmail,
    from: fromEmail,
    subject: `New paid order ${label}`,
    text: buildVendorText(order),
  };

  try {
    await sgMail.send(msg);
  } catch (err) {
    console.error("sendVendorEmail failed:", err);
  }
}

function buildCustomerText(order) {
  const lines = [];
  lines.push(`Hi ${order.customer.name || ""},`);
  lines.push("");
  lines.push("Thank you for your order from SAI Goods. Here are your order details:");
  lines.push("");
  if (order.orderRef) {
    lines.push(`Order reference: ${order.orderRef}`);
    lines.push("");
  }
  for (const item of order.items) {
    lines.push(
      `- ${item.name} (${item.slug}): ${item.lineCases} case(s) - ${item.lineTotalFormatted}`,
    );
  }
  lines.push("");
  lines.push(`Subtotal: ${order.subtotalFormatted}`);
  lines.push(`Shipping: ${order.shippingFormatted}`);
  lines.push(`Tax: ${order.taxFormatted}`);
  lines.push(`Total: ${order.totalFormatted}`);
  lines.push("");
  lines.push("We will contact you if we need any additional information about your shipment.");
  lines.push("");
  lines.push("Best regards,");
  lines.push("SAI Goods");
  return lines.join("\n");
}

function buildVendorText(order) {
  const lines = [];
  lines.push("New paid order received.");
  lines.push("");
  if (order.orderRef) {
    lines.push(`Order reference: ${order.orderRef}`);
  }
  lines.push(`Order ID: ${order.id}`);
  lines.push(`Payment provider: Square`);
  lines.push(`Payment ID: ${order.paymentId || "n/a"}`);
  lines.push("");
  lines.push("Customer:");
  lines.push(`- Name: ${order.customer.name || ""}`);
  lines.push(`- Email: ${order.customer.email || ""}`);
  lines.push(`- Phone: ${order.customer.phone || ""}`);
  lines.push(`- Address: ${order.customer.address || ""}`);
  lines.push("");
  lines.push("Items:");
  for (const item of order.items) {
    lines.push(
      `- ${item.name} (${item.slug}): ${item.lineCases} case(s) - ${item.lineTotalFormatted}`,
    );
  }
  lines.push("");
  lines.push(`Subtotal: ${order.subtotalFormatted}`);
  lines.push(`Shipping: ${order.shippingFormatted}`);
  lines.push(`Tax: ${order.taxFormatted}`);
  lines.push(`Total: ${order.totalFormatted}`);
  lines.push("");
  lines.push("Please log in to the admin systems to manage fulfillment.");
  return lines.join("\n");
}

