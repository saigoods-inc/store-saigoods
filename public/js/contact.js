import { initSite } from "./site.js";

document.addEventListener("DOMContentLoaded", () => {
  void initSite({ page: "contact" });
  const form = document.querySelector("#business-inquiry-form");
  initOrganizationDropdown(form);
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const status = document.querySelector("#inquiry-status");
    button.disabled = true;
    button.querySelector("[data-submit-label]").textContent = "Sending…";
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
      button.querySelector("[data-submit-label]").textContent = "Submit inquiry";
    }
  });
});

function initOrganizationDropdown(form) {
  const select = form?.querySelector('[name="org_type"]');
  if (!select) return;
  const wrapper = select.parentElement;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'checkout-state-select__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-labelledby', 'org-label org-value');
  trigger.setAttribute('aria-controls', 'org-options');
  trigger.innerHTML = '<span id="org-value"></span><span class="checkout-state-select__chevron" aria-hidden="true"></span>';
  const menu = document.createElement('div');
  menu.id = 'org-options'; menu.className = 'checkout-state-select__menu';
  menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-labelledby', 'org-label'); menu.hidden = true;
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  const options = [...select.options].map(option => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'checkout-state-select__option';
    button.setAttribute('role', 'option'); button.tabIndex = -1;
    button.textContent = option.textContent;
    button.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles:true })); close(); trigger.focus(); });
    menu.append(button); return button;
  });
  const sync = () => {
    trigger.querySelector('span').textContent = select.selectedOptions[0].textContent;
    options.forEach((option,i) => { option.setAttribute('aria-selected', String(i === select.selectedIndex)); option.classList.toggle('is-selected', i === select.selectedIndex); });
    trigger.removeAttribute('aria-invalid');
  };
  const open = () => { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); options[Math.max(0, select.selectedIndex)].focus(); };
  trigger.addEventListener('click', () => menu.hidden ? open() : close());
  trigger.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
  menu.addEventListener('keydown', event => {
    const index = options.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
    else if (event.key === 'Tab') close();
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next].focus();
    } else if (event.key.length === 1 && /[a-z]/i.test(event.key)) {
      const match = options.find(option => option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) { event.preventDefault(); match.focus(); }
    }
  });
  document.addEventListener('click', event => { if (!wrapper.contains(event.target)) close(); });
  wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
  select.addEventListener('change', sync);
  select.addEventListener('invalid', event => { event.preventDefault(); trigger.setAttribute('aria-invalid','true'); trigger.focus(); });
  form.addEventListener('reset', () => setTimeout(sync, 0));
  wrapper.append(trigger, menu); wrapper.classList.add('enhanced');
  select.tabIndex = -1; select.setAttribute('aria-hidden','true'); sync();
}
