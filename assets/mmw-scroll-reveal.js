// mmw-scroll-reveal — globalna animacja "podjazd + wygaszenie" dla bloków
// wchodzących w viewport przy scrollu. Jeden IntersectionObserver dla całej
// strony (nie jeden na sekcję/blok) — moduł ES jest dedupe'owany przez
// przeglądarkę po URL, więc <script src="mmw-scroll-reveal.js"> w kilku
// sekcjach na tej samej stronie i tak wykonuje się raz (ten sam wzorzec co
// mmw-photo-stack.js/mmw-story-stack.js, patrz CLAUDE.md).
//
// Stan początkowy (opacity:0) siedzi w CSS (mmw-scroll-reveal-styles.liquid)
// pod `.mmw-reveal-ready [data-mmw-reveal]` — `.mmw-reveal-ready` dodaje
// OSOBNY, blokujący inline <script> w <head> (snippets/mmw-tokens.liquid),
// NIE ten moduł. Powód: ten plik jest `type="module"` (deferred), więc
// wykonuje się PO pierwszym malowaniu — zmierzone opóźnienie na rzuconej
// sieci ~2.1s (patrz CLAUDE.md, sekcja o błysku treści/FOUC). Gdyby stan
// początkowy zależał od TEGO modułu, treść zdążyłaby się wyrenderować w
// pełni widoczna, zanim moduł ją schowa — dokładnie ten błąd. Ten moduł
// odpowiada tylko za KTÓRE elementy w końcu się odsłaniają i kiedy
// (obserwator, stagger, fallback) — nie za sam fakt bycia domyślnie ukrytym.
// Bez JS w ogóle: blokujący skrypt też się nie wykona, `.mmw-reveal-ready`
// nigdy nie trafia na `<html>`, więc strona wygląda normalnie.
//
// `data-mmw-reveal-onload` (dodatkowy, opcjonalny atrybut obok data-mmw-reveal)
// — dla treści z definicji zawsze na pierwszym ekranie (hero: logo/nagłówek/
// podtytuł/przyciski), która MA się animować mimo że nigdy nie "wchodzi" przez
// scroll. Osobna, dopisana gałąź w pętli klasyfikacji niżej — reszta mechaniki
// (IntersectionObserver, scroll-sweep fallback, stagger per sekcja) nietknięta.
import { prefersReducedMotion, removeWillChangeOnAnimationEnd } from '@theme/utilities';

const SELECTOR = '[data-mmw-reveal]';
const STAGGER_MS = 80;
const STAGGER_STEPS_CAP = 4; // opóźnienie przestaje rosnąć po 5. bloku (indeksy 0..4)

function animateIn(el) {
  el.style.willChange = 'transform, opacity';
  el.addEventListener('animationend', removeWillChangeOnAnimationEnd);
  el.removeAttribute('data-mmw-reveal-pending');
  el.setAttribute('data-mmw-reveal-in', '');
}

function init() {
  const items = document.querySelectorAll(SELECTOR);
  if (items.length === 0) return;

  if (prefersReducedMotion()) {
    // Zero ruchu, wszystko widoczne — nic nie obserwujemy, nic nie chowamy.
    return;
  }

  const sectionCounters = new Map();
  function nextDelay(el) {
    const sectionEl = el.closest('.shopify-section') || document.body;
    const index = sectionCounters.get(sectionEl) || 0;
    sectionCounters.set(sectionEl, index + 1);
    return Math.min(index, STAGGER_STEPS_CAP) * STAGGER_MS;
  }

  const viewportHeight = window.innerHeight;
  const pending = [];

  for (const el of items) {
    // Element z definicji na pierwszym ekranie (np. treść hero — logo/nagłówek/
    // podtytuł/przyciski) — animuje się NATYCHMIAST przy starcie strony,
    // niezależnie od scrolla/IntersectionObserver. Nie dotyczy to elementu tła
    // (LCP) — ten atrybut celowo NIE siedzi na tle, tylko na treści nad nim.
    // Keyframe animacji sam definiuje stan początkowy (opacity:0/translateY),
    // więc nie trzeba osobno przechodzić przez stan `pending`.
    if (el.hasAttribute('data-mmw-reveal-onload')) {
      el.style.setProperty('--mmw-reveal-delay', `${nextDelay(el)}ms`);
      animateIn(el);
      continue;
    }

    const rect = el.getBoundingClientRect();
    // Już widoczny (albo fizycznie POWYŻEJ viewportu — element, obok którego
    // użytkownik już przescrollował zanim ten skrypt się wykonał) pokazuje
    // się od razu, bez animacji. `data-mmw-reveal-shown` jest tu KONIECZNY,
    // nie kosmetyczny: CSS chowa [data-mmw-reveal] domyślnie pod
    // .mmw-reveal-ready (patrz mmw-scroll-reveal-styles.liquid) już od
    // pierwszego malowania — bez jawnego odznaczenia ten element nigdy nie
    // zostałby ponownie odkryty (nie jest obserwowany), zostając niewidoczny
    // na stałe.
    if (rect.top < viewportHeight) {
      el.setAttribute('data-mmw-reveal-shown', '');
      continue;
    }

    el.style.setProperty('--mmw-reveal-delay', `${nextDelay(el)}ms`);
    el.setAttribute('data-mmw-reveal-pending', '');
    pending.push(el);
  }

  if (pending.length === 0) return;

  const pendingSet = new Set(pending);

  function settle(el) {
    pendingSet.delete(el);
    observer.unobserve(el);
    if (pendingSet.size === 0) {
      window.removeEventListener('scroll', onScroll);
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          settle(entry.target);
          animateIn(entry.target);
        }
      }
    },
    { threshold: 0.15 }
  );

  // Zabezpieczenie niezależne od IntersectionObserver: przy skokowym scrollu
  // (np. natychmiastowy window.scrollTo na sam dół, klawisz End) element może
  // przeskoczyć z "jeszcze nie widoczny" na "już całkowicie nad viewportem"
  // W JEDNEJ klatce, nigdy nie przecinając progu przecięcia — obserwator w
  // takim wypadku NIE dostaje żadnego wywołania dla tego elementu (ratio szło
  // 0%→0%), więc zabezpieczenie musi żyć poza jego callbackiem. Zwykły scroll
  // listener (throttled przez rAF) po prostu sam sprawdza pozycje pozostałych
  // elementów — te same kryteria co przy starcie ("już nie jest poniżej
  // fold-a" obejmuje zarówno "widoczny", jak i "już minięty").
  let rafId = null;
  function sweep() {
    rafId = null;
    for (const el of pendingSet) {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        settle(el);
        animateIn(el);
      }
    }
  }
  function onScroll() {
    if (rafId === null) {
      rafId = requestAnimationFrame(sweep);
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  for (const el of pending) {
    observer.observe(el);
  }
}

// type="module" jest deferred z natury (wykonuje się po sparsowaniu DOM,
// jak natywny `defer`) — bez dodatkowego nasłuchu na DOMContentLoaded,
// ten sam wzorzec co assets/mmw-page-hero-video.js.
init();
