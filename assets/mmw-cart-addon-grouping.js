/**
 * mmw-cart-addon-grouping — strona koszyka: usuwa osierocone dodatki do
 * wydarzenia (bilet usunięty, dodatek został) i wizualnie grupuje pozostałe
 * pod odpowiadającym biletem. Patrz blocks/mmw-cart-addon-grouping.liquid.
 *
 * WAŻNE: line item properties (_event_id) przychodzą z przeglądarki i dają
 * się spreparować. To wygoda dla klienta (sprzątanie po usunięciu biletu),
 * NIE zabezpieczenie — nie opierać na tym niczego krytycznego.
 */
import { ThemeEvents } from '@theme/events';
import { morphSection } from '@theme/section-renderer';

const ORPHAN_NOTICE = 'Dodatki do wydarzenia wymagają biletu w koszyku — usunęliśmy je, bo bilet został usunięty.';

let running = false;

async function run() {
  if (running) return;
  running = true;

  try {
    const cart = await fetchCart();
    if (!cart) return;

    const { eventIdByKey, eventTitleById, orphanKeys } = analyze(cart);

    if (orphanKeys.length > 0) {
      // Nie bierzemy pierwszego lepszego cart-items-component — w drawerze
      // (header, globalnie) może istnieć osobna instancja. Id sekcji bierzemy
      // wprost z wiersza, który faktycznie modyfikujemy, żeby uniknąć pomyłki.
      const cartItemsSectionId = document
        .querySelector('.cart-items__table-row[data-key]')
        ?.closest('.shopify-section')?.id.replace('shopify-section-', '');
      const freshCart = await removeOrphans(orphanKeys, cartItemsSectionId);
      showNotice();

      const fresh = analyze(freshCart ?? cart);
      applyGrouping(fresh.eventIdByKey, fresh.eventTitleById);
      return;
    }

    applyGrouping(eventIdByKey, eventTitleById);
  } catch (error) {
    console.error(error);
  } finally {
    running = false;
  }
}

async function fetchCart() {
  try {
    const response = await fetch('/cart.js');
    return await response.json();
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * @param {{ items: Array<{ key: string, product_id: number, properties: Record<string, string> }> }} cart
 */
function analyze(cart) {
  const eventIdByKey = new Map();
  const eventTitleById = new Map();
  const ticketProductIds = new Set();

  for (const item of cart.items) {
    const eventId = item.properties?.['_event_id'];
    if (eventId) {
      eventIdByKey.set(item.key, eventId);
      const eventTitle = item.properties?.['_event_title'];
      if (eventTitle) eventTitleById.set(String(eventId), eventTitle);
    } else {
      ticketProductIds.add(String(item.product_id));
    }
  }

  const orphanKeys = [];
  for (const [key, eventId] of eventIdByKey) {
    if (!ticketProductIds.has(String(eventId))) orphanKeys.push(key);
  }

  return { eventIdByKey, eventTitleById, orphanKeys };
}

/**
 * /cart/change.js jest per-linia (natywne ograniczenie Shopify API, nie nasze) —
 * usuwamy sieroty jedna po drugiej, morphujemy dopiero po ostatniej.
 * @param {string[]} keys
 * @param {string | undefined} sectionId
 */
async function removeOrphans(keys, sectionId) {
  let lastCart = null;

  for (const key of keys) {
    const body = sectionId ? { id: key, quantity: 0, sections: sectionId } : { id: key, quantity: 0 };
    const response = await fetch(Theme.routes.cart_change_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    lastCart = await response.json();
  }

  if (sectionId && lastCart?.sections?.[sectionId]) {
    morphSection(sectionId, lastCart.sections[sectionId]);
  }

  return lastCart;
}

function showNotice() {
  const notice = document.querySelector('[data-mmw-cart-notice]');
  if (!notice) return;
  notice.textContent = ORPHAN_NOTICE;
  notice.hidden = false;
}

/**
 * @param {Map<string, string>} eventIdByKey
 * @param {Map<string, string>} eventTitleById
 */
function applyGrouping(eventIdByKey, eventTitleById) {
  document.querySelectorAll('.cart-items__table-row[data-key]').forEach((row) => {
    const eventId = eventIdByKey.get(row.dataset.key);
    row.classList.toggle('cart-items__table-row--mmw-addon', Boolean(eventId));

    const container = row.querySelector('.cart-items__product-info');
    if (!container) return;

    if (!eventId) {
      container.querySelector('[data-mmw-addon-caption]')?.remove();
      return;
    }

    let caption = container.querySelector('[data-mmw-addon-caption]');
    if (!caption) {
      caption = document.createElement('p');
      caption.setAttribute('data-mmw-addon-caption', '');
      caption.className = 'mmw-cart-grouping__caption';
      container.appendChild(caption);
    }

    const eventTitle = eventTitleById.get(String(eventId));
    caption.textContent = eventTitle ? `Dodatek do: ${eventTitle}` : 'Dodatek do wydarzenia';
  });
}

document.addEventListener(ThemeEvents.cartUpdate, run);
run();
