import { Component } from '@theme/component';
import { prefersReducedMotion } from '@theme/utilities';

const DURATION_MS = 1600;

/** ease-out (cubic) — szybki start, wyhamowanie pod koniec, zgodnie ze specyfikacją. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * mmw-stats-counter — animacja odliczania liczb w sections/mmw-stats.liquid,
 * wyzwalana wejściem CAŁEGO rzędu w viewport (IntersectionObserver, raz,
 * unobserve po starcie) — stąd jeden custom element na cały .mmw-stats__row,
 * nie po jednym na pojedynczą liczbę, żeby wszystkie cztery ruszały razem.
 *
 * Wartość każdej liczby to TEKST ("200K+", "5000+"), nie liczba — animowany
 * jest wyłącznie wiodący ciąg cyfr (regex ^\d+), reszta stringa (sufiks)
 * dokleja się z powrotem statycznie po każdej klatce. Źródłem prawdy dla
 * wartości jest textContent już wyrenderowany przez Liquid (bez osobnego
 * atrybutu data-* — nie dubluje się wartość w dwóch miejscach). Wartość bez
 * wiodącej cyfry (np. "ponad 100") zostaje niezmieniona — nie ma dopasowania
 * do regexu, więc element jest pomijany w pętli animacji.
 *
 * @extends {Component}
 */
export class MmwStatsCounter extends Component {
  /** @type {boolean} */
  #started = false;

  /** @type {IntersectionObserver | null} */
  #observer = null;

  connectedCallback() {
    super.connectedCallback();

    if (prefersReducedMotion()) {
      // Liczby są już wyrenderowane server-side z docelową wartością —
      // bez animacji nie ma nic do zrobienia.
      return;
    }

    this.#observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry?.isIntersecting) this.#start();
      },
      { threshold: 0.2 }
    );
    this.#observer.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  #start() {
    if (this.#started) return;
    this.#started = true;
    this.#observer?.disconnect();
    this.#observer = null;

    const items = (this.refs.numbers ?? [])
      .map((el) => {
        const raw = el.textContent ?? '';
        const match = raw.match(/^\d+/);
        if (!match) return null;
        return { el, target: parseInt(match[0], 10), suffix: raw.slice(match[0].length) };
      })
      .filter((item) => item !== null);

    if (items.length === 0) return;

    const startTime = performance.now();

    /** @param {number} now */
    const tick = (now) => {
      const progress = Math.min((now - startTime) / DURATION_MS, 1);
      const eased = easeOutCubic(progress);

      for (const item of items) {
        const value = progress < 1 ? Math.round(item.target * eased) : item.target;
        item.el.textContent = `${value}${item.suffix}`;
      }

      if (progress < 1) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }
}

if (!customElements.get('mmw-stats-counter')) {
  customElements.define('mmw-stats-counter', MmwStatsCounter);
}
