/**
 * mmw-event-cart — łączy bilet na wydarzenie (natywny <product-form-component>)
 * i wybrane dodatki (<mmw-event-addons>.getSelectedAddons()) w JEDNO żądanie
 * fetch('/cart/add.js', { items: [...] }), zamiast natywnego pojedynczego submitu.
 *
 * Natywny ProductFormComponent#handleSubmit (assets/product-form.js) obsługuje
 * submit przez globalny delegowany listener na document w fazie capture
 * (assets/component.js), zarejestrowany raz przy starcie strony — nie da się
 * go wiarygodnie "wyprzedzić" kolejnością rejestracji ani fazą capture z tego
 * pliku, bo document zawsze jest pierwszy w capture, niezależnie od tego, gdzie
 * podepniemy własny listener. Zamiast ścigać się o kolejność, usuwamy atrybuty
 * on:submit (product-form-component) i on:click (przycisk) — te same delegowane
 * listenery po prostu przestają znajdować handler dla tych elementów i submit/
 * klik obsługujemy w całości sami, bez ryzyka wyścigu.
 *
 * WAŻNE — kolejność w wire(): oba atrybuty zdejmujemy DOPIERO PO tym, jak nasz
 * własny listener submit jest faktycznie podpięty, nigdy wcześniej. Jeśli ten
 * plik się nie załaduje (błąd sieci, zablokowany skrypt, wyjątek przy
 * parsowaniu) albo cokolwiek w tej funkcji rzuci wyjątek przed tą linią,
 * natywne atrybuty zostają na miejscu i przycisk nadal działa — po staremu,
 * sam bilet bez dodatków, zamiast martwego przycisku. Gorsza funkcjonalność
 * jest tu świadomie preferowana nad całkowitą awarią.
 */
import { sectionRenderer } from '@theme/section-renderer';
import { CartAddEvent } from '@theme/events';

const SOLD_OUT_MESSAGE = 'Część wybranych pozycji jest już niedostępna. Odświeżyliśmy dostępność — sprawdź swój wybór i spróbuj ponownie.';

function wire(addonsEl) {
  const root = addonsEl.closest('.shopify-section');
  if (!root) return;

  const formComponent = root.querySelector('product-form-component');
  const form = formComponent?.querySelector('form');
  if (!formComponent || !form) return;

  const sectionId = root.id.replace('shopify-section-', '');
  const addToCartButton = formComponent.querySelector('[ref="addToCartButton"]');
  const addToCartContainer = addToCartButton?.closest('add-to-cart-component');

  if (form.dataset.mmwCartWired !== 'true') {
    let submitting = false;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submitting) return;

      submitting = true;
      setLoading(addToCartButton, true);
      addonsEl.clearAvailabilityError?.();

      try {
        const formData = new FormData(form);
        const ticketId = Number(formData.get('id'));
        const ticketQuantity = Number(formData.get('quantity')) || 1;

        if (!ticketId) return;

        const items = [{ id: ticketId, quantity: ticketQuantity }];

        const addons = addonsEl.getSelectedAddons?.() ?? [];
        for (const addon of addons) {
          // Rozwinięty dodatek bez wybranej godziny nie ma id — pomijamy całkowicie,
          // getSelectedAddons() już to filtruje, ale dodatkowa straż nie zaszkodzi.
          if (!addon.id || !addon.quantity) continue;
          items.push({ id: addon.id, quantity: addon.quantity, properties: addon.properties });
        }

        const sectionIds = [];
        document.querySelectorAll('cart-items-component').forEach((el) => {
          if (el instanceof HTMLElement && el.dataset.sectionId) sectionIds.push(el.dataset.sectionId);
        });

        const response = await fetch(Theme.routes.cart_add_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items, sections: sectionIds.join(',') }),
        });
        const result = await response.json();

        if (!response.ok || result.status) {
          await handleError({ addonsEl, sectionId });
          return;
        }

        addToCartContainer?.animateAddToCart?.();

        const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
        document.dispatchEvent(
          new CartAddEvent(result, sectionId, {
            source: 'product-form-component',
            itemCount: totalQuantity,
            productId: formComponent.dataset.productId,
            sections: result.sections,
          })
        );
      } catch (error) {
        console.error(error);
      } finally {
        submitting = false;
        setLoading(addToCartButton, false);
      }
    });

    form.dataset.mmwCartWired = 'true';
  }

  // Dopiero teraz — gdy własny listener submit już na pewno jest podpięty
  // (właśnie powyżej, albo wcześniej na tym samym węźle) — zdejmujemy natywne
  // atrybuty. Idempotentne: po odświeżeniu sekcji (błąd 422) świeże HTML z
  // serwera znów będzie je miało, trzeba je zdjąć ponownie przy każdym wire().
  //
  // on:click: natywny AddToCartComponent#handleClick odpala animację "lot do
  // koszyka" OPTYMISTYCZNIE, na sam klik — zanim jeszcze wiemy, czy żądanie
  // się powiedzie. Dla kombinowanego bilet+dodatki to mylące przy 422 (patrz
  // konwersacja). Odpalamy animację sami, tylko po realnym sukcesie (wyżej).
  // #animateFlyToCart jest prywatną metodą klasy — nie da się jej wywołać
  // z zewnątrz, więc zostaje tylko publiczny animateAddToCart() (stan "dodano"
  // na przycisku), bez efektu "lecącej" ikonki.
  formComponent.removeAttribute('on:submit');
  addToCartButton?.removeAttribute('on:click');
}

/**
 * @param {{ addonsEl: HTMLElement & { showAvailabilityError?: Function }, sectionId: string }} params
 */
async function handleError({ addonsEl, sectionId }) {
  // Komunikat NAJPIERW, natychmiast, na elemencie który już mamy — nie może
  // zależeć od tego, czy odświeżenie sekcji poniżej się powiedzie/zawiśnie.
  // /cart/add.js dla żądania wsadowego nie mówi, KTÓRA konkretnie pozycja
  // padła — jedyny realistyczny scenariusz z brief to brak miejsc w wybranej
  // godzinie dodatku, więc pokazujemy ten komunikat zawsze.
  addonsEl?.showAvailabilityError?.(SOLD_OUT_MESSAGE);

  try {
    // Odśwież całą sekcję (dostępność wariantów w selectach dodatków, stan
    // biletu itd.), żeby klient nie próbował ponownie tej samej opcji. Morph
    // zastępuje DOM świeżym server-side HTML, które ma error ukryty od nowa
    // — stąd druga aplikacja komunikatu poniżej, PO odświeżeniu.
    await sectionRenderer.renderSection(sectionId, { cache: false });
  } catch (error) {
    console.error(error);
    return; // odświeżenie się nie powiodło — komunikat sprzed chwili nadal widoczny, to wystarczy
  }

  document.querySelectorAll('mmw-event-addons').forEach(wire);
  document.querySelector('mmw-event-addons')?.showAvailabilityError?.(SOLD_OUT_MESSAGE);
}

/**
 * @param {HTMLButtonElement | null | undefined} button
 * @param {boolean} isLoading
 */
function setLoading(button, isLoading) {
  if (!button) return;
  button.disabled = isLoading;
  button.classList.toggle('mmw-loading', isLoading);
}

document.querySelectorAll('mmw-event-addons').forEach(wire);
