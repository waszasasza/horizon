import { Component } from '@theme/component';
import { prefersReducedMotion } from '@theme/utilities';

/**
 * mmw-photo-stack — stos zdjęć jako PRZEŁĄCZNIK (tablist/tab/tabpanel), nie
 * dekoracja. Świadoma duplikacja mechaniki mmw-story-stack (assets/mmw-story-stack.js),
 * nie rozszerzenie/reużycie — uzasadnienie w CLAUDE.md i w podsumowaniu dostawy.
 *
 * Przełączanie WYŁĄCZNIE przez: klik, przeciągnięcie (mysz/dotyk/pen —
 * bez filtrowania po pointerType) i klawiaturę. Samo najechanie kursorem
 * NIE zmienia aktywnej karty — fan-out na hover jest czystym efektem
 * wizualnym w CSS, bez śladu w JS (usunięty mechanizm hover-intent, patrz
 * historia zmian). Bez auto-advance (usunięty wcześniej).
 *
 * Różnice od Stories, które wykluczały reużycie:
 * - tekst w osobnym, zsynchronizowanym panelu z crossfade (Stories trzyma
 *   tekst wewnątrz karty).
 * - pełny wzorzec ARIA tablist/tab/tabpanel (Stories przełącza
 *   aria-hidden/tabindex na kartach bezpośrednio, bez tabpanel).
 *
 * Wzorzec (nie kod) fan-outu — CSS custom properties per pozycja, gated
 * @media (hover:hover) and (prefers-reduced-motion:no-preference) — powielony
 * z mmw-story-stack.js / blocks/mmw-story-stack.liquid. Mechanika przeciągania
 * (#handlePointerDown/#dismiss) to również port z mmw-story-stack.js — sama
 * oś, próg, kierunek (patrz raport dostawy). W odróżnieniu od Stories drag tu
 * działa dla WSZYSTKICH pointerType (mouse/touch/pen) — Stories filtruje
 * tylko dodatkowe przyciski myszy, nie sam typ wskaźnika, patrz
 * `event.button !== 0 && event.pointerType === 'mouse'` niżej.
 *
 * @typedef {Object} Refs
 * @property {HTMLButtonElement[]} [cards]
 * @property {HTMLElement[]} [panels]
 * @property {HTMLElement} [arrow]
 *
 * @extends {Component<Refs>}
 */
export class MmwPhotoStack extends Component {
  requiredRefs = ['cards', 'panels'];

  /** Liczba pozycji z rotacją własną (3 wartości z Figmy) — karty poza tym
   * zakresem dostają IDENTYCZNY transform co pozycja MAX_VISIBLE_DEPTH,
   * czyli są w pełni przesłonięte, bez odrębnej rotacji do "wyczerpania". */
  static MAX_VISIBLE_DEPTH = 2;

  /** Próg ruchu (px), powyżej którego pointerup NIE ma już traktować gestu
   * jako zwykłego tapnięcia/kliknięcia — kolejny natywny click na <button>
   * zostaje pominięty, żeby przeciągnięcie i klik nie robiły tego samego
   * dwa razy. */
  static CLICK_SUPPRESS_THRESHOLD = 6;

  /** @type {number} */
  #current = 0;

  /** @type {number} */
  #total = 0;

  /** @type {boolean} */
  #dragging = false;

  /** @type {boolean} */
  #suppressNextClick = false;

  /** @type {IntersectionObserver | null} */
  #arrowObserver = null;

  connectedCallback() {
    super.connectedCallback();

    this.#total = this.refs.cards?.length ?? 0;
    if (this.#total === 0) return;

    this.#render();
    this.#observeArrow();

    if (this.#total < 2) return;

    this.refs.cards?.forEach((card, index) => {
      card.addEventListener('focus', () => this.#activate(index));
      card.addEventListener('pointerdown', (event) => this.#handlePointerDown(event, card));
      card.addEventListener('click', () => {
        if (this.#suppressNextClick) return;
        this.#activate(index);
      });
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#arrowObserver?.disconnect();
    this.#arrowObserver = null;
  }

  /**
   * Rysowanie strzałki-bazgrołu wyzwolone KAŻDYM wejściem sekcji w viewport,
   * nie tylko pierwszym — bez unobserve. Przy wyjściu z viewportu animacja
   * jest cofana do stanu początkowego (klasa zdjęta + stroke-dashoffset
   * jawnie ustawiony na UJEMNĄ pełną długość ścieżki, policzoną przez
   * przeglądarkę przez `path.getTotalLength()` — NIE zahardkodowana liczba,
   * żeby zawsze zgadzała się z rzeczywistą geometrią, niezależnie od tego,
   * co jest wpisane w `stroke-dasharray` w {% stylesheet %}; znak minus to
   * ten sam mechanizm co w bazowej regule CSS — odwraca kierunek rysowania
   * na koniec→początek, patrz komentarz przy `stroke-dashoffset: -400` w
   * {% stylesheet %}), żeby przy kolejnym
   * wejściu było co animować od nowa; wymuszony reflow
   * (`void arrow.offsetWidth`) przed ponownym dodaniem klasy gwarantuje, że
   * przeglądarka faktycznie przeliczy style między zdjęciem a dodaniem
   * klasy (bez tego czysta zamiana klasy w tej samej klatce bywa scalana i
   * animacja się nie restartuje). prefers-reduced-motion nie wymaga tu
   * gałęzi warunkowej — CSS pokazuje stan końcowy bezwarunkowo
   * (stroke-dashoffset:0 !important) niezależnie od klasy .is-visible,
   * patrz sections/mmw-photo-stack.liquid.
   */
  #observeArrow() {
    const arrow = this.refs.arrow;
    if (!arrow) return;

    const path = arrow.querySelector('path');

    this.#arrowObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void arrow.offsetWidth;
            arrow.classList.add('is-visible');
          } else {
            arrow.classList.remove('is-visible');
            if (path) path.style.strokeDashoffset = String(-path.getTotalLength());
          }
        }
      },
      { threshold: 0.2 }
    );
    this.#arrowObserver.observe(this);
  }

  /** Advances to the next block. */
  next() {
    if (this.#total < 2) return;
    this.#activate((this.#current + 1) % this.#total);
  }

  /** Goes back to the previous block. */
  previous() {
    if (this.#total < 2) return;
    this.#activate((this.#current - 1 + this.#total) % this.#total);
  }

  /**
   * Declarative on:keydown handler (Component ref/on: system). Strzałki
   * przełączają i przenoszą focus na nowo aktywną kartę (roving tabindex),
   * jak w natywnym sections/layered-slideshow.liquid (assets/layered-slideshow.js).
   * @param {KeyboardEvent} event
   */
  handleKeydown(event) {
    if (this.#total < 2) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.next();
      this.refs.cards?.[this.#current]?.focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.previous();
      this.refs.cards?.[this.#current]?.focus();
    }
  }

  /**
   * @param {number} index
   */
  #activate(index) {
    // Blokada na wszelki wypadek: #render() nie może przemalować kart w
    // trakcie trwającego przeciągnięcia z żadnego innego powodu niż jego
    // zakończenie (patrz #handlePointerDown/onUp, gdzie #dragging jest
    // zerowane PRZED ewentualnym wywołaniem #dismiss → next() → #activate).
    if (this.#dragging) return;
    if (index === this.#current) return;
    this.#current = index;
    this.#render();
  }

  /**
   * Przeciąganie — działa dla KAŻDEGO pointerType (mysz, dotyk, pen), bez
   * filtrowania. Port mechaniki z #handlePointerDown w
   * assets/mmw-story-stack.js — ta sama oś (pozioma), ten sam próg
   * dystansu/prędkości, ten sam kierunek (kierunek przeciągnięcia steruje
   * WYŁĄCZNIE tym, w którą stronę karta odlatuje wizualnie — w Stories
   * przeciągnięcie w dowolną stronę zawsze wywołuje next(), nie previous();
   * ta sama konwencja zachowana tutaj, patrz #dismiss). Guard na
   * `event.button` też ze Stories — ignoruje prawy/środkowy przycisk
   * myszy (lewy = button 0), żeby nie zaczynać przeciągania np. przy próbie
   * otwarcia menu kontekstowego.
   * Ruch powyżej CLICK_SUPPRESS_THRESHOLD ustawia #suppressNextClick, żeby
   * następny natywny click na <button> (odpalany przez przeglądarkę po
   * pointerup) nie wywołał #activate drugi raz dla tej samej karty. Flaga
   * jest zerowana na POCZĄTKU każdego nowego gestu (tutaj, nie w
   * listenerze click) — inaczej przerwane przeciągnięcie (pointercancel
   * poniżej progu, bez następującego po nim click) zostawiało flagę na
   * `true` i połykało kolejne, zupełnie niezwiązane kliknięcie.
   * @param {PointerEvent} event
   * @param {HTMLElement} card
   */
  #handlePointerDown(event, card) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (this.#dragging) return;
    if (card.getAttribute('data-depth') !== '0') return;

    this.#suppressNextClick = false;

    const cardWidth = card.offsetWidth || 1;
    const startX = event.clientX;
    const startTime = performance.now();
    let deltaX = 0;

    this.#dragging = true;
    card.setPointerCapture(event.pointerId);
    card.style.transition = 'none';

    /** @param {PointerEvent} moveEvent */
    const onMove = (moveEvent) => {
      deltaX = moveEvent.clientX - startX;
      if (Math.abs(deltaX) > MmwPhotoStack.CLICK_SUPPRESS_THRESHOLD) {
        this.#suppressNextClick = true;
      }
      card.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 24}deg)`;
    };

    const onUp = () => {
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);

      this.#dragging = false;
      card.style.transition = '';

      const elapsed = Math.max(performance.now() - startTime, 1);
      const velocity = Math.abs(deltaX) / elapsed;
      const distanceThreshold = cardWidth * 0.25;
      const isFastFlick = velocity > 0.6 && Math.abs(deltaX) > 20;

      if (Math.abs(deltaX) > distanceThreshold || isFastFlick) {
        this.#dismiss(card, deltaX < 0 ? -1 : 1);
      } else {
        card.style.transform = '';
      }
    };

    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
  }

  /**
   * @param {HTMLElement} card
   * @param {1 | -1} direction
   */
  #dismiss(card, direction) {
    if (prefersReducedMotion()) {
      card.style.transform = '';
      this.next();
      return;
    }

    const flyDistance = direction * card.offsetWidth * 1.2;

    const onTransitionEnd = () => {
      card.removeEventListener('transitionend', onTransitionEnd);
      card.style.transition = 'none';
      card.style.transform = '';
      card.style.opacity = '';
      this.next();

      requestAnimationFrame(() => {
        card.style.transition = '';
      });
    };

    card.addEventListener('transitionend', onTransitionEnd, { once: true });
    card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
    card.style.transform = `translateX(${flyDistance}px) rotate(${direction * 18}deg)`;
    card.style.opacity = '0';
  }

  #render() {
    const { cards, panels } = this.refs;

    cards?.forEach((card, index) => {
      const depth = (index - this.#current + this.#total) % this.#total;
      const cappedDepth = Math.min(depth, MmwPhotoStack.MAX_VISIBLE_DEPTH);
      card.style.zIndex = String(this.#total - depth);
      card.setAttribute('data-depth', String(cappedDepth));
      card.setAttribute('aria-selected', depth === 0 ? 'true' : 'false');
      card.tabIndex = depth === 0 ? 0 : -1;
    });

    panels?.forEach((panel, index) => {
      panel.toggleAttribute('inert', index !== this.#current);
    });
  }
}

if (!customElements.get('mmw-photo-stack')) {
  customElements.define('mmw-photo-stack', MmwPhotoStack);
}
