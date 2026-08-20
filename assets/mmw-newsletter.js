import { Component } from '@theme/component';

/**
 * Rewizja Klaviyo REST API (Klaviyo wersjonuje po dacie, nie semver) — dla
 * client-side subscribe endpointu użytego niżej. Podbijana RĘCZNIE, gdy
 * świadomie zdecydujemy się przejść na nowszą rewizję — nie ma tu
 * auto-update. Źródła (sprawdzone przy pisaniu tego pliku, nie z pamięci):
 * kształt endpointu/body — https://developers.klaviyo.com/en/reference/create_client_subscription
 * cykl życia rewizji — https://developers.klaviyo.com/en/docs/api_versioning_and_deprecation_policy
 */
const KLAVIYO_API_REVISION = '2026-07-15';

const KLAVIYO_SUBSCRIBE_URL = 'https://a.klaviyo.com/client/subscriptions';

/** Mikro-copy strukturalna (nie treść merchanta) — celowo NIE ustawienie
 * schema, tak samo jak SOLD_OUT_MESSAGE w assets/mmw-event-cart.js. */
const CONSENT_REQUIRED_MESSAGE = 'Zaznacz zgodę, aby się zapisać.';

/**
 * mmw-newsletter-discount — zapis do listy Klaviyo bezpośrednio z
 * przeglądarki (POST do publicznego client-side subscribe endpointu Klaviyo),
 * bez natywnego {% form 'customer' %} — uzasadnienie na górze
 * sections/mmw-newsletter-discount.liquid.
 *
 * @typedef {Object} Refs
 * @property {HTMLFormElement} [form]
 * @property {HTMLInputElement} [emailInput]
 * @property {HTMLInputElement} [consentInput]
 * @property {HTMLButtonElement} [submitButton]
 * @property {HTMLElement} [errorMessage]
 * @property {HTMLElement} [successMessage]
 *
 * @extends {Component<Refs>}
 */
export class MmwNewsletterForm extends Component {
  requiredRefs = ['form', 'emailInput', 'consentInput', 'submitButton', 'errorMessage', 'successMessage'];

  /** @type {boolean} */
  #submitting = false;

  /**
   * Declarative on:submit handler (form ref="form" on:submit="/handleSubmit").
   * @param {SubmitEvent} event
   */
  handleSubmit(event) {
    event.preventDefault();
    if (this.#submitting) return;
    this.#submit();
  }

  async #submit() {
    const emailInput = this.refs.emailInput;
    const consentInput = this.refs.consentInput;
    if (!emailInput || !consentInput) return;

    this.#hideMessage(this.refs.errorMessage);

    if (!emailInput.checkValidity()) {
      this.#showError(this.dataset.invalidEmailMessage, emailInput);
      return;
    }

    if (!consentInput.checked) {
      this.#showError(CONSENT_REQUIRED_MESSAGE, consentInput);
      return;
    }

    this.#submitting = true;
    if (this.refs.submitButton) this.refs.submitButton.disabled = true;

    try {
      const response = await fetch(`${KLAVIYO_SUBSCRIBE_URL}?company_id=${encodeURIComponent(this.dataset.publicKey ?? '')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
          revision: KLAVIYO_API_REVISION,
        },
        body: JSON.stringify({
          data: {
            type: 'subscription',
            attributes: {
              profile: {
                data: {
                  type: 'profile',
                  attributes: {
                    email: emailInput.value.trim(),
                    subscriptions: {
                      email: {
                        marketing: {
                          consent: 'SUBSCRIBED',
                        },
                      },
                    },
                  },
                },
              },
            },
            relationships: {
              list: {
                data: {
                  type: 'list',
                  id: this.dataset.listId,
                },
              },
            },
          },
        }),
      });

      if (!response.ok) {
        this.#showError(this.dataset.networkErrorMessage);
        return;
      }

      this.#succeed();
    } catch (error) {
      console.error(error);
      this.#showError(this.dataset.networkErrorMessage);
    } finally {
      this.#submitting = false;
      if (this.refs.submitButton) this.refs.submitButton.disabled = false;
    }
  }

  #succeed() {
    if (this.refs.form) this.refs.form.hidden = true;
    const success = this.refs.successMessage;
    if (!success) return;
    success.hidden = false;
    success.focus();
  }

  /**
   * @param {string | undefined} message
   * @param {HTMLElement} [focusTarget] - Domyślnie sam komunikat błędu (brak
   *   konkretnego pola do obwinienia, np. błąd sieci/API).
   */
  #showError(message, focusTarget) {
    const el = this.refs.errorMessage;
    if (el) {
      el.textContent = message ?? '';
      el.hidden = false;
    }
    (focusTarget ?? el)?.focus();
  }

  /** @param {HTMLElement | undefined} el */
  #hideMessage(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }
}

if (!customElements.get('mmw-newsletter-form')) {
  customElements.define('mmw-newsletter-form', MmwNewsletterForm);
}
