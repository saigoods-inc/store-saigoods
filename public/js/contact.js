import { initSite } from "./site.js";

export function inquiryMailto(data) {
  const fields = [["name", "Full name"], ["company", "Company or organization"],
    ["email", "Work email"], ["phone", "Phone"], ["org_type", "Organization type"],
    ["products", "Area of interest"], ["quantity", "Estimated quantity or frequency"], ["message", "Message"]];
  const body = fields.map(([key, label]) => `${label}: ${String(data.get(key) || "").trim()}`).join("\n\n");
  return `mailto:sales@saigoods.com?subject=${encodeURIComponent("SAI Goods business inquiry")}&body=${encodeURIComponent(body)}`;
}

document.addEventListener("DOMContentLoaded", () => {
  void initSite({ page: "contact" });
  const form = document.querySelector("#business-inquiry-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    if (data.get("website")) return;
    window.location.href = inquiryMailto(data);
    const status = document.querySelector("#inquiry-status");
    status.textContent = "Your email draft is ready to open. Send it from your email app to complete your inquiry. If no app opens, email sales@saigoods.com directly.";
    status.hidden = false;
  });
});
