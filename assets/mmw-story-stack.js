import { Component } from '@theme/component';
import { prefersReducedMotion } from '@theme/utilities';

/**
 * Story-stack: swipeable stack of cards that auto-advances like Instagram Stories.
 * Cards stay in their original DOM order; cycling is done purely by recomputing
 * a `--mmw-story-depth` custom property (and `data-depth` attribute) per card,
 * so any number of cards is supported without reordering the DOM.
 *
 * @typedef {Object} Refs
 * @property {HTMLElement[]} [cards]
 * @property {HTMLElement[]} [segments]
 * @property {HTMLElement[]} [segmentFills]
 * @property {HTMLElement} [counter]
 * @property {HTMLButtonElement} [previous]
 * @property {HTMLButtonElement} [next]
 *
 * @extends {Component<Refs>}
 */
export class MmwStoryStack extends Component {
  requiredRefs = ['cards'];

  /** @type {number} */
  #current = 0;

  /** @type {number} */
  #total = 0;

  /** @type {boolean} */
  #dragging = false;

  /** @type {IntersectionObserver | null} */
  #intersectionObserver = null;

  /** Whether the touch hint has already been scheduled once for this page view. */
  #hintScheduled = false;

  /** Whether the user has already touched or navigated the stack (suppresses the hint). */
  #interacted = false;

  /** @type {number[]} */
  #hintTimeouts = [];

  connectedCallback() {
    super.connectedCallback();

    this.#total = this.refs.cards?.length ?? 0;
    if (this.#total === 0) return;

    this.#render();

    if (this.#total > 1) {
      this.addEventListener('animationend', this.#handleAnimationEnd);

      this.refs.cards?.forEach((card) => {
        card.addEventListener('pointerdown', (event) => this.#handlePointerDown(event, card));
      });

      this.#intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            this.toggleAttribute('out-of-view', !entry.isIntersecting);

            if (entry.isIntersecting && !this.#hintScheduled) {
              this.#hintScheduled = true;
              this.#scheduleHint();
            }
          }
        },
        { threshold: 0 }
      );
      this.#intersectionObserver.observe(this);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('animationend', this.#handleAnimationEnd);
    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = null;
    this.#clearHintTimeouts();
  }

  /** Advances to the next card. */
  next() {
    if (this.#total < 2) return;
    this.#markInteracted();
    this.#current = (this.#current + 1) % this.#total;
    this.#render();
  }

  /** Goes back to the previous card. */
  previous() {
    if (this.#total < 2) return;
    this.#markInteracted();
    this.#current = (this.#current - 1 + this.#total) % this.#total;
    this.#render();
  }

  /**
   * Declarative on:keydown handler (bound via the Component ref/on: system).
   * @param {KeyboardEvent} event
   */
  handleKeydown(event) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.previous();
    }
  }

  /**
   * Only the front card (depth 0) can be dragged. Follows the pointer 1:1 and,
   * past a distance/velocity threshold, flies off in the drag direction and
   * cycles to the back of the stack.
   * @param {PointerEvent} event
   * @param {HTMLElement} card
   */
  #handlePointerDown(event, card) {
    // Touching the stack always interrupts the touch hint immediately, even if this
    // particular pointerdown doesn't end up starting a drag (e.g. it landed on a
    // non-front card or a drag is already in progress).
    this.#markInteracted();

    if (this.#total < 2 || this.#dragging) return;
    if (card.getAttribute('data-depth') !== '0') return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;

    const cardWidth = card.offsetWidth || 1;
    const startX = event.clientX;
    const startTime = performance.now();
    let deltaX = 0;

    this.#dragging = true;
    card.setPointerCapture(event.pointerId);
    this.setAttribute('dragging', '');
    card.style.transition = 'none';

    /** @param {PointerEvent} moveEvent */
    const onMove = (moveEvent) => {
      deltaX = moveEvent.clientX - startX;
      card.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 24}deg)`;
    };

    const onUp = () => {
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);

      this.#dragging = false;
      this.removeAttribute('dragging');
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
   * Animates the front card flying off screen, then cycles it to the back of the stack.
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
      // Jump the dismissed card straight to its new (back of stack) position
      // without animating the return trip.
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

  /** @param {AnimationEvent} event */
  #handleAnimationEnd = (event) => {
    if (event.animationName !== 'mmw-story-progress') return;
    if (!(event.target instanceof HTMLElement)) return;
    if (!event.target.classList.contains('is-active')) return;

    this.next();
  };

  /**
   * Schedules the one-off touch "fan" hint: reuses the same [fanned] CSS transform
   * as the desktop :hover fan-out (see the stylesheet), played once ~400ms after the
   * stack first enters the viewport, held briefly, then eased back to rest. Purely
   * visual: it never touches #current/#render and the progress bar keeps running.
   */
  #scheduleHint() {
    if (prefersReducedMotion() || !matchMedia('(hover: none)').matches) return;

    const startTimeout = window.setTimeout(() => {
      if (this.#interacted) return;

      this.setAttribute('fanned', '');

      const holdTimeout = window.setTimeout(() => {
        this.removeAttribute('fanned');
      }, 350 + 500);

      this.#hintTimeouts.push(holdTimeout);
    }, 400);

    this.#hintTimeouts.push(startTimeout);
  }

  /** Marks the stack as interacted-with, cancelling/skipping the touch hint for good. */
  #markInteracted() {
    if (this.#interacted) return;
    this.#interacted = true;
    this.#clearHintTimeouts();
    this.removeAttribute('fanned');
  }

  #clearHintTimeouts() {
    this.#hintTimeouts.forEach((id) => window.clearTimeout(id));
    this.#hintTimeouts = [];
  }

  #render() {
    const { cards, segments, segmentFills, counter } = this.refs;
    const autoAdvance = this.#total > 1 && !prefersReducedMotion();

    cards?.forEach((card, index) => {
      // True depth drives stacking order and the opacity cutoff; the CSS custom
      // property is capped at 3 visible layers so 6+ cards don't grow the fan forever.
      const depth = (index - this.#current + this.#total) % this.#total;
      card.style.setProperty('--mmw-story-depth', String(Math.min(depth, 3)));
      card.style.zIndex = String(this.#total - depth);
      card.setAttribute('data-depth', String(depth));
      card.setAttribute('aria-hidden', depth === 0 ? 'false' : 'true');
      card.tabIndex = depth === 0 ? 0 : -1;
    });

    segments?.forEach((segment, index) => {
      segment.classList.toggle('is-complete', index < this.#current);
    });

    segmentFills?.forEach((fill, index) => {
      fill.classList.toggle('is-active', autoAdvance && index === this.#current);
    });

    if (counter) counter.textContent = `${this.#current + 1} z ${this.#total}`;
  }
}

if (!customElements.get('mmw-story-stack')) {
  customElements.define('mmw-story-stack', MmwStoryStack);
}
