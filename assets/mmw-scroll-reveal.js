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
// scroll. Osobna gałąź w klasyfikacji niżej.
//
// MutationObserver (patrz `classifyAll`/`domObserver` niżej) — naprawa
// realnego błędu: karty sekcji rekomendacji (Shopify natywne
// product-recommendations, fetch+wstrzyknięcie HTML-a PO własnym
// IntersectionObserver komponentu) trafiały do DOM już PO tym, jak ten
// moduł raz przeleciał stronę przy starcie — nigdy nie dostawały żadnego
// stanu (`shown`/`pending`/`in`), więc CSS chował je na stałe, zero szans na
// odkrycie. Ten sam błąd dotyczyłby DOWOLNEGO mechanizmu wstrzykującego HTML
// po starcie (Section Rendering API przy zmianie wariantu, quick-add,
// wyniki wyszukiwania) — stąd jeden globalny obserwator DOM zamiast łatania
// każdego mechanizmu z osobna. Potwierdzone bezpośrednio (Playwright, strona
// produktu z sekcją rekomendacji): 4 karty `product-card.mmw-carousel-card`
// z `computed opacity: 0`, żaden z atrybutów stanu obecny — dokładnie ten
// scenariusz.
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

function isProcessed(el) {
  return (
    el.hasAttribute('data-mmw-reveal-pending') ||
    el.hasAttribute('data-mmw-reveal-in') ||
    el.hasAttribute('data-mmw-reveal-shown')
  );
}

function main() {
  if (prefersReducedMotion()) {
    // Zero ruchu, wszystko widoczne — nic nie obserwujemy, nic nie chowamy,
    // żadnego MutationObserver (nie ma czego dynamicznie klasyfikować).
    return;
  }

  const sectionCounters = new Map();
  function nextDelay(el) {
    const sectionEl = el.closest('.shopify-section') || document.body;
    const index = sectionCounters.get(sectionEl) || 0;
    sectionCounters.set(sectionEl, index + 1);
    return Math.min(index, STAGGER_STEPS_CAP) * STAGGER_MS;
  }

  const pendingSet = new Set();

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
  // elementów — te same kryteria co przy klasyfikacji ("już nie jest poniżej
  // fold-a" obejmuje zarówno "widoczny", jak i "już minięty"). Dopinany
  // leniwie (dopiero gdy jest co obserwować) i odpinany po ostatnim elemencie
  // — nie jeden stały listener na całe życie strony.
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

  // Rdzeń klasyfikacji — wywoływany dla treści obecnej przy starcie ORAZ
  // (przez MutationObserver niżej) dla każdego elementu data-mmw-reveal
  // dodanego do DOM później, niezależnie od tego, jaki mechanizm go dodał.
  function classify(el) {
    if (isProcessed(el)) return;

    // Element z definicji na pierwszym ekranie (np. treść hero — logo/
    // nagłówek/podtytuł/przyciski) — animuje się NATYCHMIAST, niezależnie od
    // scrolla/IntersectionObserver. Nie dotyczy elementu tła (LCP) — ten
    // atrybut celowo NIE siedzi na tle, tylko na treści nad nim.
    if (el.hasAttribute('data-mmw-reveal-onload')) {
      el.style.setProperty('--mmw-reveal-delay', `${nextDelay(el)}ms`);
      animateIn(el);
      return;
    }

    const rect = el.getBoundingClientRect();
    // Już widoczny (albo fizycznie POWYŻEJ viewportu — użytkownik już
    // przescrollował, albo element dociągnięty asynchronicznie akurat blisko
    // aktualnej pozycji scrolla) pokazuje się od razu, bez animacji.
    // `data-mmw-reveal-shown` jest KONIECZNY: CSS chowa [data-mmw-reveal]
    // domyślnie pod .mmw-reveal-ready (patrz mmw-scroll-reveal-styles.liquid)
    // już od pierwszego malowania — bez jawnego odznaczenia element nigdy
    // nie zostałby ponownie odkryty, zostając niewidoczny na stałe.
    if (rect.top < window.innerHeight) {
      el.setAttribute('data-mmw-reveal-shown', '');
      return;
    }

    el.style.setProperty('--mmw-reveal-delay', `${nextDelay(el)}ms`);
    el.setAttribute('data-mmw-reveal-pending', '');
    pendingSet.add(el);
    if (pendingSet.size === 1) {
      window.addEventListener('scroll', onScroll, { passive: true });
    }
    observer.observe(el);
  }

  function classifyAll(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(SELECTOR)) classify(node);
    node.querySelectorAll(SELECTOR).forEach(classify);
  }

  classifyAll(document.body);

  // Skanuje ponownie za każdym razem, gdy do DOM trafiają nowe węzły — jeden
  // globalny obserwator dla całej strony, nie osobny per mechanizm async.
  // Dowolny fetch+wstrzyknięcie HTML-a (natywny product-recommendations.js,
  // Section Rendering API przy zmianie wariantu, quick-add-modal, wyniki
  // wyszukiwania) kończy się operacją na childList jakiegoś kontenera —
  // łapiemy to tu ogólnie, zamiast dowiązywać się do konkretnego mechanizmu
  // każdej z tych funkcji osobno (część z nich dziś w ogóle nie renderuje
  // treści z data-mmw-reveal, więc ten obserwator na razie nic tam nie robi
  // — ale jeśli kiedyś zacznie, zadziała bez dodatkowej zmiany w tym pliku).
  //
  // Throttling przez rAF + filtr na ELEMENT_NODE PRZED zaplanowaniem
  // czegokolwiek — zmierzone bezpośrednio (Playwright, homepage, scroll do
  // sekcji mmw-stats): licznik odliczania (assets/mmw-stats.js, textContent
  // co klatkę animacji) generował ~60-63 wywołania callbacku/s przez cały
  // czas trwania animacji (1.6s) — 396 z 408 zaobserwowanych rekordów
  // mutacji w typowej sesji na stronie głównej. `textContent = ...` usuwa
  // stary węzeł TEKSTOWY i dodaje nowy — nie ELEMENT — więc
  // `classifyAll`/`classify` i tak zawsze na nim natychmiast rezygnowały
  // (zero elementów `data-mmw-reveal` do znalezienia), ale bez filtra PRZED
  // zaplanowaniem, sam callback MutationObserver odpalał się identycznie
  // często niezależnie od tego. Filtr niżej odrzuca węzły tekstowe od razu,
  // więc dla przypadków w rodzaju licznika (i podobnych: dymek koszyka,
  // licznik story-stack, natywne widgety typu Judge.me) nie planuje się
  // W OGÓLE żadna praca — nie tylko rzadziej, zero. Dla rzeczywistych
  // wstawek elementów (rekomendacje itp.) przetwarzanie i tak jest
  // ograniczone do raz na klatkę animacji, nie raz na surowe wywołanie
  // callbacku obserwatora.
  const pendingNodes = [];
  let mutationRafId = null;
  function flushMutations() {
    mutationRafId = null;
    const nodes = pendingNodes.splice(0, pendingNodes.length);
    nodes.forEach(classifyAll);
  }
  const domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.push(node);
      }
    }
    if (pendingNodes.length > 0 && mutationRafId === null) {
      mutationRafId = requestAnimationFrame(flushMutations);
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });
}

main();
