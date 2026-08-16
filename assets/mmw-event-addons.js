/**
 * mmw-event-addons — progresywne ujawnianie dodatków do wydarzenia (wybór godziny +
 * ilości), poza natywnym <product-form> (Etap 4 wyśle je osobno przez /cart/add.js).
 * Stan trzymany w atrybutach data-* na wierszu; getSelectedAddons() to publiczne API
 * do odczytu przez późniejszy kod koszyka.
 */
const UNTRACKED_MAX = 99;

class MmwEventAddons extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', this.#onClick);
    this.addEventListener('change', this.#onChange);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('change', this.#onChange);
  }

  #onClick = (event) => {
    const toggle = event.target.closest('.mmw-addons__toggle');
    if (toggle) {
      this.#handleToggle(toggle);
      return;
    }

    const qtyButton = event.target.closest('[data-qty-increase], [data-qty-decrease]');
    if (qtyButton) {
      const row = qtyButton.closest('[data-addon-row]');
      if (!row) return;
      const delta = qtyButton.hasAttribute('data-qty-increase') ? 1 : -1;
      this.#stepQuantity(row, delta);
    }
  };

  #onChange = (event) => {
    const select = event.target.closest('[data-addon-variant-select]');
    if (!select) return;
    const row = select.closest('[data-addon-row]');
    if (!row) return;
    this.#handleVariantChange(row, select);
  };

  #handleToggle(toggle) {
    const row = toggle.closest('[data-addon-row]');
    if (!row) return;
    const controls = row.querySelector('.mmw-addons__controls');
    const expanded = row.getAttribute('data-expanded') === 'true';
    const next = !expanded;

    row.setAttribute('data-expanded', String(next));
    toggle.setAttribute('aria-expanded', String(next));
    if (controls) controls.toggleAttribute('inert', !next);

    if (next) {
      // Dodatek z jednym wariantem: nie ma selecta, wariant jest ustalony od razu.
      const fixedVariantId = row.dataset.addonFixedVariantId;
      if (fixedVariantId) {
        row.dataset.addonVariantId = fixedVariantId;
        row.dataset.addonQuantity = '1';
        this.#setQuantityDisplay(row, 1);
        this.#syncQuantityButtons(row);
      }
    } else {
      this.#resetRow(row);
    }
  }

  #resetRow(row) {
    delete row.dataset.addonVariantId;
    delete row.dataset.addonQuantity;
    this.#setQuantityDisplay(row, 1);
    const select = row.querySelector('[data-addon-variant-select]');
    if (select) select.value = '';
    this.#syncQuantityButtons(row);
  }

  #handleVariantChange(row, select) {
    const option = select.selectedOptions[0];
    if (!option || option.value === '') {
      delete row.dataset.addonVariantId;
      delete row.dataset.addonQuantity;
    } else {
      row.dataset.addonVariantId = option.value;
      row.dataset.addonQuantity = '1';
    }
    this.#setQuantityDisplay(row, 1);
    this.#syncQuantityButtons(row);
  }

  #getMax(row) {
    const select = row.querySelector('[data-addon-variant-select]');
    let tracked;
    let policy;
    let max;

    if (select) {
      const option = select.selectedOptions[0];
      if (!option || option.value === '') return null;
      tracked = option.dataset.tracked;
      policy = option.dataset.policy;
      max = Number(option.dataset.max || 0);
    } else {
      tracked = row.dataset.addonFixedVariantTracked;
      policy = row.dataset.addonFixedVariantPolicy;
      max = Number(row.dataset.addonFixedVariantMax || 0);
    }

    if (!tracked || policy === 'continue') return UNTRACKED_MAX;
    return max > 0 ? max : UNTRACKED_MAX;
  }

  #stepQuantity(row, delta) {
    const max = this.#getMax(row);
    if (max === null) return;
    const current = Number(row.dataset.addonQuantity || 1);
    const next = Math.min(Math.max(current + delta, 1), max);
    row.dataset.addonQuantity = String(next);
    this.#setQuantityDisplay(row, next);
    this.#syncQuantityButtons(row);
  }

  #setQuantityDisplay(row, value) {
    const display = row.querySelector('[data-qty-value]');
    if (display) display.textContent = String(value);
  }

  #syncQuantityButtons(row) {
    const max = this.#getMax(row);
    const current = Number(row.dataset.addonQuantity || 1);
    const decrease = row.querySelector('[data-qty-decrease]');
    const increase = row.querySelector('[data-qty-increase]');
    const disabled = max === null;

    if (decrease) decrease.disabled = disabled || current <= 1;
    if (increase) increase.disabled = disabled || current >= max;
  }

  /**
   * @returns {{ id: number, quantity: number, properties: { _event_id: string, _event_title: string, Godzina?: string } }[]}
   */
  getSelectedAddons() {
    const rows = this.querySelectorAll('[data-addon-row]');
    const selected = [];

    rows.forEach((row) => {
      const variantId = row.dataset.addonVariantId;
      const quantity = row.dataset.addonQuantity;
      if (!variantId || !quantity) return;

      const properties = {
        _event_id: this.dataset.eventId,
        _event_title: this.dataset.eventTitle,
      };

      // "Default Title" to sentinel Shopify dla jednowariantowych produktów bez
      // realnych opcji — nie jest to godzina, klient nie powinien jej zobaczyć
      // w koszyku/checkoucie/mailu. Klucz pomijamy całkowicie, nie wysyłamy
      // pustego stringa.
      const variantTitle = this.#getVariantTitle(row, variantId);
      if (variantTitle && variantTitle !== 'Default Title') {
        properties.Godzina = variantTitle;
      }

      selected.push({
        id: Number(variantId),
        quantity: Number(quantity),
        properties,
      });
    });

    return selected;
  }

  #getVariantTitle(row, variantId) {
    const select = row.querySelector('[data-addon-variant-select]');
    if (select) {
      const option = select.querySelector(`option[value="${variantId}"]`);
      return option ? option.textContent.trim() : '';
    }
    return row.dataset.addonFixedVariantTitle || '';
  }

  /**
   * Pokazuje komunikat o niedostępności przy bloku dodatków (np. po 422 z /cart/add.js).
   * @param {string} message
   */
  showAvailabilityError(message) {
    const errorEl = this.querySelector('[data-addons-error]');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  clearAvailabilityError() {
    const errorEl = this.querySelector('[data-addons-error]');
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
}

if (!customElements.get('mmw-event-addons')) {
  customElements.define('mmw-event-addons', MmwEventAddons);
}
