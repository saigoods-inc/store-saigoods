import { initSite } from "./site.js";

document.addEventListener("DOMContentLoaded", () => {
  void initSite({ page: "contact" });
  const form = document.querySelector("#business-inquiry-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const status = document.querySelector("#inquiry-status");
    button.disabled = true;
    button.textContent = "Sending…";
    status.hidden = false;
    status.dataset.error = "false";
    status.textContent = "Sending your inquiry…";
    try {
      const response = await fetch("/api/contact-inquiry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to send your inquiry. Please try again.");
      status.textContent = "Thank you. Your inquiry has been sent to our team.";
      form.reset();
    } catch (error) {
      status.dataset.error = "true";
      status.textContent = error.message || "Unable to send your inquiry. Please try again.";
    } finally {
      button.disabled = false;
      button.textContent = "Submit inquiry";
    }
  });
});
