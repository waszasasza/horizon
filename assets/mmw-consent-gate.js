/**
 * mmw-consent-gate — dostępny komunikat błędu dla wymaganego checkboxa
 * zgody marketingowej w natywnych formularzach Shopify (form 'customer'):
 * newsletter w stopce (mmw-footer) i katalog PDF (mmw-firms-catalog).
 * Identyczny mechanizm w obu miejscach, stąd wspólny plik.
 *
 * Świadomie BEZ `novalidate`/przechwytywania `submit`: atrybut `required`
 * na checkboxie sam blokuje wysyłkę nawet gdy ten skrypt się nie wykona —
 * oba formularze muszą działać bez JS (w odróżnieniu od
 * mmw-newsletter-discount, które i tak zależy od fetch do Klaviyo, więc
 * `novalidate` tam nic nie ryzykuje). Ten skrypt tylko zamienia natywny
 * dymek walidacji na własny, dostępny komunikat powiązany przez
 * aria-describedby — przez zdarzenie `invalid`, nie `submit`.
 *
 * @param {Element} root - wrapper zawierający dokładnie jeden checkbox zgody
 *   i element komunikatu błędu ([data-mmw-consent-error]).
 */
function initConsentGate(root) {
  const checkbox = root.querySelector('input[type="checkbox"]');
  const error = root.querySelector('[data-mmw-consent-error]');
  if (!(checkbox instanceof HTMLInputElement) || !(error instanceof HTMLElement)) return;

  checkbox.setAttribute('aria-describedby', error.id);

  checkbox.addEventListener('invalid', (event) => {
    event.preventDefault();
    error.hidden = false;
    checkbox.setAttribute('aria-invalid', 'true');
    checkbox.focus();
  });

  checkbox.addEventListener('change', () => {
    if (!checkbox.checked) return;
    error.hidden = true;
    checkbox.removeAttribute('aria-invalid');
  });
}

document.querySelectorAll('[data-mmw-consent-gate]').forEach(initConsentGate);
