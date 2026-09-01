#!/usr/bin/env node
// Naprawa wzorca A z audytu (audyt-handli.md) — "ł" ginące bez śladu przy
// transliteracji handle'a produktu (np. "Tłocznia" -> "tocznia" zamiast
// "tlocznia"). Dotyczy WYŁĄCZNIE wzorca A — nic z sekcji "inne" audytu
// (systemowe/domyślne handle'e, ręcznie rozszerzone, zamienione po
// duplikacji) nie jest tu ruszane, nawet jeśli przypadkiem ma "ł" w środku.
//
// 26 kandydatów wykrytych automatycznie (dopasowanie 1:1 do rekonstrukcji
// wzorca A z tytułu) + 2 dopisane ręcznie w MANUAL_OVERRIDES niżej —
// "Skarpetki - freski pałacowe"/"Skarpetki - pałac" mają w handle'u ręcznie
// doklejony kod rozmiaru ("-r-40-42"), którego nie ma w tytule wcale, więc
// automatyczna metoda (dopasowanie do transliteracji TYTUŁU) je odrzucała —
// naprawiałaby tylko "ł", ale i tak nie zgadzałaby się 1:1, bo nie umie
// odtworzyć rozmiaru spoza tytułu. Dla tych dwóch handle podany explicite,
// nie generowany z tytułu — poprawiamy wyłącznie brakujące "ł", reszta
// (w tym "-r-40-42") zostaje bez zmian. Razem: 28.
//
// Redirecty: świadomie WYŁĄCZONE (redirectNewHandle: false w mutacji
// productUpdate). Zweryfikowane bezpośrednio (introspekcja GraphQL na
// naszej wersji API 2026-07): redirectNewHandle to pole na ProductUpdateInput,
// domyślnie nie ustawiane = brak przekierowania — w odróżnieniu od edycji
// handle'a w Adminie (tam jest checkbox "Create a URL redirect", domyślnie
// zaznaczony), zmiana przez API nigdy nie tworzy redirectu, chyba że
// jawnie go poprosisz. Powód: stare handle'e nigdy nie były zindeksowane
// (sklep za hasłem) — redirect z nieistniejącego w wyszukiwarkach adresu
// byłby zbędnym wpisem do sprzątania później, bez żadnej korzyści SEO.
//
// Sprawdzone przed napisaniem tego skryptu (osobno, poza nim): żaden z 26
// produktów wzorca A nie jest linkowany z treści żadnego z 11 artykułów
// bloga (przeszukane pełne body wszystkich artykułów, zero trafień
// "/products/<handle>") — więc treść artykułów NIE wymaga aktualizacji po
// tej zmianie.
//
// Idempotentny: re-liczy transliterację z aktualnego tytułu przy każdym
// uruchomieniu (nie z zapisanego wcześniej audytu), pomija produkty, których
// handle już jest poprawny (np. przy ponownym uruchomieniu po częściowym
// commicie). Sprawdza kolizje handle'i (czy proponowany handle nie jest już
// zajęty przez INNY produkt) przed jakąkolwiek mutacją.
//
// Użycie:
//   node napraw-handle-l-produkty.mjs            # dry-run (domyślnie)
//   node napraw-handle-l-produkty.mjs --commit    # realny zapis

import process from 'node:process';
import dotenv from 'dotenv';
import { shopifyGraphQLWithRetry, sleep } from './lib/shopify-graphql.mjs';

dotenv.config();

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!STORE || !TOKEN) throw new Error('Brak SHOPIFY_STORE/SHOPIFY_ADMIN_TOKEN w scripts/.env');

const COMMIT = process.argv.includes('--commit');

// ---- Transliteracja: identyczna metoda co w audycie (audyt-handli.md) ----

const POLISH_MAP = {
  ą: 'a', ć: 'c', ę: 'e', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'a', Ć: 'c', Ę: 'e', Ń: 'n', Ó: 'o', Ś: 's', Ź: 'z', Ż: 'z',
};

function transliterate(title, { dropL = false, glueHardSpace = false } = {}) {
  if (!title) return '';
  let s = title;
  s = glueHardSpace ? s.replace(/ /g, '') : s.replace(/ /g, ' ');
  s = s.replace(/[ąćęńóśźżĄĆĘŃÓŚŹŻ]/g, (ch) => POLISH_MAP[ch]);
  s = dropL ? s.replace(/[łŁ]/g, '') : s.replace(/[łŁ]/g, 'l');
  s = s.toLowerCase();
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

function isPureLBug(title, actualHandle) {
  const proposed = transliterate(title, { dropL: false, glueHardSpace: false });
  if (actualHandle === proposed) return { isBug: false, proposed };
  const onlyA = transliterate(title, { dropL: true, glueHardSpace: false });
  return { isBug: actualHandle === onlyA, proposed };
}

// ---- Fetch wszystkich produktow (id, title, handle) ----

async function fetchAllProducts() {
  const q = /* GraphQL */ `
    query ($cursor: String) {
      products(first: 100, after: $cursor) {
        nodes { id title handle }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  let cursor = null;
  const all = [];
  while (true) {
    const json = await shopifyGraphQLWithRetry({ store: STORE, token: TOKEN, query: q, variables: { cursor } });
    if (json.errors) throw new Error(`products: ${JSON.stringify(json.errors)}`);
    all.push(...json.data.products.nodes);
    if (!json.data.products.pageInfo.hasNextPage) break;
    cursor = json.data.products.pageInfo.endCursor;
  }
  return all;
}

// Rozszerzenie o 2 produkty pominięte przez metodę wykrywania (isPureLBug wymaga
// dokładnego 1:1 dopasowania do rekonstrukcji wzorca A z tytułu — te dwa mają w
// handle'u ręcznie doklejony człon "-r-40-42" (kod rozmiaru), którego NIE ma w
// tytule w ogóle, więc transliteracja z tytułu nigdy by go nie odtworzyła i
// obcięłaby rozmiar). Handle podane explicite, NIE generowane z tytułu — poprawiamy
// wyłącznie brakujące "ł", człon "-r-40-42" zostaje bez zmian.
const MANUAL_OVERRIDES = [
  { oldHandle: 'skarpetki-freski-paacowe-r-40-42', newHandle: 'skarpetki-freski-palacowe-r-40-42' },
  { oldHandle: 'skarpetki-paac-r-40-42', newHandle: 'skarpetki-palac-r-40-42' },
];

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation ($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle }
      userErrors { field message }
    }
  }
`;

async function main() {
  console.log('Pobieram produkty...');
  const products = await fetchAllProducts();
  console.log(`  -> ${products.length}\n`);

  const existingHandles = new Set(products.map((p) => p.handle));

  const candidates = [];
  for (const p of products) {
    const { isBug, proposed } = isPureLBug(p.title, p.handle);
    if (!isBug) continue; // pomija OK i wszystko poza czystym wzorcem A (np. "inne")
    if (p.handle === proposed) continue; // juz naprawione (idempotencja)
    const collision = existingHandles.has(proposed) && !products.some((o) => o.id === p.id && o.handle === proposed);
    candidates.push({ id: p.id, title: p.title, oldHandle: p.handle, newHandle: proposed, collision });
  }

  for (const override of MANUAL_OVERRIDES) {
    const p = products.find((x) => x.handle === override.oldHandle);
    if (!p) {
      console.log(`⚠️  Pominięto ręczny wpis — nie znaleziono produktu o handle '${override.oldHandle}' (zmieniony od czasu audytu?).`);
      continue;
    }
    if (candidates.some((c) => c.id === p.id)) continue; // juz na liscie z automatycznej detekcji, nie dubluj
    if (p.handle === override.newHandle) continue; // juz naprawione
    const collision = existingHandles.has(override.newHandle) && !products.some((o) => o.id === p.id && o.handle === override.newHandle);
    candidates.push({ id: p.id, title: p.title, oldHandle: p.handle, newHandle: override.newHandle, collision });
  }

  if (candidates.length === 0) {
    console.log('Brak kandydatow do naprawy (wzorzec A) — albo juz wszystko naprawione, albo dane sie zmienily od audytu.');
    return;
  }

  console.log(`Kandydaci do naprawy (wzorzec A): ${candidates.length}\n`);
  console.log('| Tytuł | Stary handle | Nowy handle | Status |');
  console.log('|---|---|---|---|');
  for (const c of candidates) {
    const status = c.collision ? '⚠️ KOLIZJA — pomijam' : (COMMIT ? 'do zapisu' : 'dry-run');
    console.log(`| ${c.title} | \`${c.oldHandle}\` | \`${c.newHandle}\` | ${status} |`);
  }

  const collisions = candidates.filter((c) => c.collision);
  if (collisions.length > 0) {
    console.log(`\n⚠️  ${collisions.length} produkt(y) pominięte przez kolizję handle'a — proponowany handle jest już zajęty przez inny produkt. Wymaga ręcznej decyzji, nie naprawiane automatycznie.`);
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — nic nie zapisano. Uruchom z --commit po akceptacji tabeli.');
    return;
  }

  const toCommit = candidates.filter((c) => !c.collision);
  console.log(`\nZapisuję ${toCommit.length} produkt(y) (redirectNewHandle: false — bez tworzenia przekierowań)...\n`);

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < toCommit.length; i++) {
    const c = toCommit[i];
    process.stdout.write(`[${i + 1}/${toCommit.length}] ${c.title}: ${c.oldHandle} -> ${c.newHandle} ... `);
    const json = await shopifyGraphQLWithRetry({
      store: STORE,
      token: TOKEN,
      query: PRODUCT_UPDATE,
      variables: { product: { id: c.id, handle: c.newHandle, redirectNewHandle: false } },
    });
    const userErrors = json.data?.productUpdate?.userErrors ?? [];
    if (json.errors || userErrors.length > 0) {
      failed++;
      console.log('BŁĄD:', JSON.stringify(json.errors ?? userErrors));
    } else {
      ok++;
      console.log('OK');
    }
    await sleep(500);
  }

  console.log(`\nGotowe. OK: ${ok}, błędy: ${failed}, pominięte przez kolizję: ${collisions.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
