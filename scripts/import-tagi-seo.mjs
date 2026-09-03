#!/usr/bin/env node
// Import tagów produktowych + tytułów SEO z eksportu Matrixify (1_produkty.xlsx) do Shopify
// przez Admin GraphQL API. Zapala 10 pustych kolekcji automatycznych (scripts/import-kolekcje.mjs),
// które działają na regułach tagowych — tagów dotąd nie było.
//
// Dry-run domyślnie — zapis wyłącznie z --commit.
//
// Użycie:
//   node import-tagi-seo.mjs --file ./import-marek/1_produkty.xlsx --remap ./import-marek/remap-handle.csv
//   node import-tagi-seo.mjs --file ... --remap ... [--tylko-tagi | --tylko-seo] [--commit]
//
// ---------------------------------------------------------------------------------------
// Decyzja projektowa (nie kwestionować, patrz prompt zadania): tagi wgrywamy WPROST z pliku
// klienta, nie wyprowadzamy z metapól — scripts/inspect-metafields.mjs wykazał, że metapola
// nie pokrywają tych wymiarów (custom.typ_wina koduje trzy wymiary w jednym polu tekstowym
// na zaledwie 19 produktach). Ten skrypt NIE dotyka żadnych metapól — nawet gdy plik i
// custom.typ_wina są ze sobą sprzeczne (patrz sekcja "znane rozbieżności" w raporcie).
//
// Weryfikacja schematu API 2026-07 (introspekcja + test na żywo z fałszywym ID, zero
// realnego zapisu — ten sam wzorzec co przy imporcie kolekcji):
//   - tagsAdd(id: ID!, tags: [String!]!) — istnieje, NIE deprecated.
//   - productUpdate — argument zmienił nazwę z `input` na `product: ProductUpdateInput`
//     (ten sam wzorzec przesunięcia co przy collectionCreate/-Update), ale to zwykła
//     mutacja typu "partial update": pola pominięte w wejściu NIE są ruszane. Potwierdzone
//     wprost opisem pola `tags` w schemacie: "Updating `tags` overwrites any existing
//     tags... To add new tags without overwriting existing tags, use tagsAdd" — czyli
//     Shopify sam dokumentuje tagsAdd jako właściwe narzędzie do addytywnego tagowania,
//     zgodnie z ZAKAZEM nr 3 w tym zadaniu. Ten skrypt NIGDY nie wysyła pola `tags` w
//     productUpdate — wyłącznie `id` + `seo`, więc tagi produktu są przez tę mutację
//     całkowicie nietknięte niezależnie od powyższego zachowania „overwrite”.
// ---------------------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import xlsx from 'xlsx';
import { shopifyGraphQLWithRetry, sleep } from './lib/shopify-graphql.mjs';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!STORE || !TOKEN) {
  console.error('Brak SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN w scripts/.env');
  process.exit(1);
}

const PAGE_SIZE = 250;
const RATE_LIMIT_DELAY_MS = 550;

// ZAKAZ nr 4: klient wycofał nazewnictwo "okazja:voucher" — pomijamy bezwarunkowo.
const SKIP_TAG = 'okazja:voucher';

// KROK 4: znane, świadomie NIEnaprawiane rozbieżności plik vs custom.typ_wina (raportowane,
// nie zmieniane — ani tagi nie są pomijane, ani metapole nie jest ruszane).
const KNOWN_DISCREPANCIES = {
  'vicu-medusa-2024': {
    fileTagi: ['slodkosc:polslodkie', 'typ:musujace'],
    metapoleTypWina: 'białe półwytrawne',
  },
  'solaris-polwytrawny-2024': {
    fileTagi: ['slodkosc:polwytrawne'],
    metapoleTypWina: 'wytrawne',
  },
};

function parseArgs(argv) {
  const args = { dryRun: true, file: null, remap: null, tylkoTagi: false, tylkoSeo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else if (a === '--remap') args.remap = argv[++i];
    else if (a.startsWith('--remap=')) args.remap = a.slice('--remap='.length);
    else if (a === '--tylko-tagi') args.tylkoTagi = true;
    else if (a === '--tylko-seo') args.tylkoSeo = true;
  }
  return args;
}

function norm(s) {
  return (s ?? '').toString().trim();
}

async function gql(query, variables = {}) {
  const json = await shopifyGraphQLWithRetry({ store: STORE, token: TOKEN, query, variables });
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// ---------------------------------------------------------------------------------- XLSX / CSV

function readSheet(filePath, sheetName) {
  const wb = xlsx.readFile(filePath);
  if (!wb.SheetNames.includes(sheetName)) {
    throw new Error(`Brak arkusza "${sheetName}" w ${filePath}. Dostępne: ${wb.SheetNames.join(', ')}`);
  }
  return xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

// Ten sam parser co w import-kolekcje.mjs (obsługa cudzysłowów, dziś niepotrzebna w tym
// konkretnym pliku, ale remap-handle.csv jest generowany z tytułów produktów).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function readRemapCsv(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  const headers = rows[0];
  const map = new Map(); // stary_handle -> proponowany_handle | null
  for (const r of rows.slice(1)) {
    const obj = Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']));
    const stary = norm(obj.stary_handle);
    const proponowany = norm(obj.proponowany_handle);
    if (stary) map.set(stary, proponowany || null);
  }
  return map;
}

// ---------------------------------------------------------------------------------- fetch stanu sklepu

async function fetchAllProducts() {
  const map = new Map(); // handle -> { id, handle, tags: string[], seoTitle: string|null }
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($cursor: String) {
        products(first: ${PAGE_SIZE}, after: $cursor) {
          nodes { id handle tags seo { title } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor }
    );
    for (const n of data.products.nodes) {
      map.set(n.handle, { id: n.id, handle: n.handle, tags: n.tags, seoTitle: n.seo?.title ?? null });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return map;
}

// ---------------------------------------------------------------------------------- mutacje (--commit)

async function addTags(productId, tags) {
  const data = await gql(
    `mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }`,
    { id: productId, tags }
  );
  const errs = data.tagsAdd.userErrors;
  if (errs.length) throw new Error(`tagsAdd(${productId}): ${errs.map((e) => e.message).join('; ')}`);
}

async function updateSeoTitle(productId, title) {
  const data = await gql(
    `mutation($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id }
        userErrors { field message }
      }
    }`,
    { product: { id: productId, seo: { title } } }
  );
  const errs = data.productUpdate.userErrors;
  if (errs.length) throw new Error(`productUpdate(${productId}): ${errs.map((e) => e.message).join('; ')}`);
}

// ---------------------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !args.remap) {
    console.error('Użycie: node import-tagi-seo.mjs --file <1_produkty.xlsx> --remap <remap-handle.csv> [--commit] [--tylko-tagi|--tylko-seo]');
    process.exit(1);
  }
  const doTagi = !args.tylkoSeo;
  const doSeo = !args.tylkoTagi;

  const filePath = path.resolve(args.file);
  const remapPath = path.resolve(args.remap);
  if (!existsSync(filePath)) {
    console.error(`Plik nie istnieje: ${filePath}`);
    process.exit(1);
  }
  if (!existsSync(remapPath)) {
    console.error(`Plik nie istnieje: ${remapPath}`);
    process.exit(1);
  }

  console.log(args.dryRun ? 'Tryb: DRY-RUN (bez zapisu do Shopify)' : 'Tryb: COMMIT (realny zapis do Shopify)');
  console.log(`Zakres: ${doTagi ? 'tagi ' : ''}${doSeo ? 'SEO' : ''}${!doTagi && !doSeo ? '(nic — sprzeczne flagi?)' : ''}`);
  console.log('');

  const rows = readSheet(filePath, 'Products');
  const remapMap = readRemapCsv(remapPath);

  console.log(`Wczytano ${rows.length} wierszy z arkusza Products.`);
  console.log(`remap-handle.csv: ${remapMap.size} wierszy.`);
  console.log('');

  console.log('Pobieram stan sklepu (produkty, tagi, SEO)...');
  const productMap = await fetchAllProducts();
  console.log(`Produkty w sklepie: ${productMap.size}`);
  console.log('');

  // --- Krok 1: rozwiązanie handli --------------------------------------------------------
  const unresolved = [];
  let resolvedDirect = 0;
  let resolvedRemap = 0;

  function resolveHandle(rawHandle) {
    if (productMap.has(rawHandle)) {
      resolvedDirect++;
      return { handle: rawHandle, via: 'wprost' };
    }
    const mapped = remapMap.get(rawHandle);
    if (mapped && productMap.has(mapped)) {
      resolvedRemap++;
      return { handle: mapped, via: 'remap' };
    }
    return null;
  }

  const resolvedRows = [];
  for (const r of rows) {
    const rawHandle = norm(r.Handle);
    if (!rawHandle) continue;
    const resolved = resolveHandle(rawHandle);
    if (!resolved) {
      unresolved.push(rawHandle);
      continue;
    }
    resolvedRows.push({ fileHandle: rawHandle, storeHandle: resolved.handle, row: r });
  }

  // --- Krok 2: tagi -----------------------------------------------------------------------
  const tagPlans = []; // { storeHandle, productId, tagsToAdd: string[] }
  const voucherAffected = []; // { storeHandle, untouched: boolean }
  const tagDistribution = new Map(); // tag -> liczba produktów, ktore go dostana

  for (const { fileHandle, storeHandle, row } of resolvedRows) {
    const rawTagsCol = norm(row.Tags);
    if (!rawTagsCol) continue;
    const fileTags = rawTagsCol
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const hadVoucher = fileTags.includes(SKIP_TAG);
    const filteredTags = fileTags.filter((t) => t !== SKIP_TAG);

    if (filteredTags.length === 0) {
      // ZAKAZ nr 4 skutek uboczny: produkt, którego JEDYNYM tagiem w pliku był
      // "okazja:voucher" — po odfiltrowaniu nie ma nic do dodania, więc zostaje
      // nietknięty przez część tagową w ogóle.
      if (hadVoucher) voucherAffected.push({ storeHandle, untouched: true });
      continue;
    }

    const product = productMap.get(storeHandle);
    const existing = new Set(product.tags);
    const tagsToAdd = filteredTags.filter((t) => !existing.has(t));
    if (hadVoucher) voucherAffected.push({ storeHandle, untouched: tagsToAdd.length === 0 });
    if (tagsToAdd.length === 0) continue; // różnica pusta — nie wysyłamy pustej mutacji

    tagPlans.push({ fileHandle, storeHandle, productId: product.id, tagsToAdd });
    for (const t of tagsToAdd) tagDistribution.set(t, (tagDistribution.get(t) ?? 0) + 1);
  }

  // --- Krok 3: tytuły SEO -------------------------------------------------------------------
  const seoPlans = []; // { storeHandle, productId, before, after }
  let seoUnchanged = 0;

  for (const { fileHandle, storeHandle, row } of resolvedRows) {
    const fileSeoTitle = norm(row['Metafield: title_tag']);
    if (!fileSeoTitle) continue;
    const product = productMap.get(storeHandle);
    const currentSeoTitle = norm(product.seoTitle);
    if (fileSeoTitle === currentSeoTitle) {
      seoUnchanged++;
      continue;
    }
    seoPlans.push({ fileHandle, storeHandle, productId: product.id, before: currentSeoTitle, after: fileSeoTitle });
  }

  // --- Krok 4: znane rozbieżności ------------------------------------------------------------
  const discrepancyReport = [];
  for (const [storeHandle, info] of Object.entries(KNOWN_DISCREPANCIES)) {
    const plan = tagPlans.find((p) => p.storeHandle === storeHandle);
    discrepancyReport.push({
      storeHandle,
      fileTagi: info.fileTagi,
      metapoleTypWina: info.metapoleTypWina,
      tagiZostanaWgrane: plan ? plan.tagsToAdd.filter((t) => info.fileTagi.includes(t)) : [],
    });
  }

  // ---------------------------------------------------------------------------- RAPORT (Krok 5/6)

  const line = (s = '') => console.log(s);

  line('='.repeat(70));
  line('KROK 2 — TAGI');
  line('='.repeat(70));
  line(`Produktów, które dostaną nowe tagi: ${tagPlans.length}`);
  const totalTagsToAdd = tagPlans.reduce((acc, p) => acc + p.tagsToAdd.length, 0);
  line(`Łączna liczba tagów do dodania: ${totalTagsToAdd}`);
  line(`Unikalnych tagów do wgrania: ${tagDistribution.size}`);
  line('');
  line('Rozkład (tag -> liczba produktów):');
  [...tagDistribution.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([t, c]) => line(`  ${String(c).padStart(3)}  ${t}`));
  line('');
  const voucherInFileTotal = rows.filter((r) =>
    norm(r.Tags)
      .split(',')
      .map((t) => t.trim())
      .includes(SKIP_TAG)
  ).length;
  line(`Pominięcie "${SKIP_TAG}": wierszy w pliku z tym tagiem: ${voucherInFileTotal} (oczekiwano 5).`);
  line(`  Z tego dotarło do etapu liczenia różnicy tagów (miało rozwiązywalny handle): ${voucherAffected.length}.`);
  if (voucherInFileTotal !== voucherAffected.length) {
    line(
      `  Różnica (${voucherInFileTotal - voucherAffected.length}) to produkt(y) już wcześniej wylądowały na liście`
    );
    line(`  NIEROZWIĄZANYCH (patrz sekcja niżej) — nie osobny problem, ten sam znany przypadek.`);
  }
  const voucherUntouched = voucherAffected.filter((v) => v.untouched);
  line(`  Z czego bez żadnego innego tagu do dodania (nietknięte przez część tagową): ${voucherUntouched.length}`);
  voucherUntouched.forEach((v) => line(`    - ${v.storeHandle}`));
  line('');

  if (tagPlans.length > 0) {
    line('Plan dodania tagów (pierwsze 10):');
    tagPlans.slice(0, 10).forEach((p) => line(`  ${p.storeHandle}: +[${p.tagsToAdd.join(', ')}]`));
    line('');
  }

  line('='.repeat(70));
  line('KROK 3 — TYTUŁY SEO');
  line('='.repeat(70));
  line(`Do zmiany: ${seoPlans.length}`);
  line(`Już zgodne (bez zmian): ${seoUnchanged}`);
  line('');
  line('Pierwsze 10 zmian tytułu:');
  seoPlans.slice(0, 10).forEach((p) => line(`  ${p.storeHandle}: "${p.before || '(puste)'}" -> "${p.after}"`));
  line('');

  line('='.repeat(70));
  line(`PRODUKTY NIEROZWIĄZANE (${unresolved.length})`);
  line('='.repeat(70));
  if (unresolved.length === 0) line('  (brak)');
  unresolved.forEach((h) => line(`  - ${h}`));
  line('');

  line('='.repeat(70));
  line('MAPOWANIE HANDLI');
  line('='.repeat(70));
  line(`Rozwiązane wprost: ${resolvedDirect}`);
  line(`Rozwiązane przez remap: ${resolvedRemap}`);
  line('');

  line('='.repeat(70));
  line(`KROK 4 — ZNANE ROZBIEŻNOŚCI plik vs custom.typ_wina (NIE naprawiane)`);
  line('='.repeat(70));
  for (const d of discrepancyReport) {
    line(`  ${d.storeHandle}`);
    line(`    plik (tagi): ${d.fileTagi.join(', ')}`);
    line(`    custom.typ_wina (sklep): "${d.metapoleTypWina}"`);
    line(`    tagi zostaną wgrane zgodnie z plikiem: ${d.tagiZostanaWgrane.length ? d.tagiZostanaWgrane.join(', ') : '(już miał te tagi / brak w planie — sprawdź wyżej)'}`);
    line(`    metapole custom.typ_wina: NIETKNIĘTE`);
  }
  line('');

  line('='.repeat(70));
  line('WERYFIKACJA WOBEC OCZEKIWANYCH WARTOŚCI Z PROMPTU');
  line('='.repeat(70));
  const rowsWithTags = rows.filter((r) => norm(r.Tags) !== '').length;
  const rowsWithSeoTitle = rows.filter((r) => norm(r['Metafield: title_tag']) !== '').length;
  const checks = [
    ['wiersze w arkuszu Products', rows.length, 118],
    ['produkty z niepustą kolumną Tags', rowsWithTags, 36],
    ['produkty, które faktycznie dostaną tagi', tagPlans.length, 31],
    ['unikalnych tagów do wgrania', tagDistribution.size, 17],
    ['produkty z tytułem SEO w pliku', rowsWithSeoTitle, 118],
  ];
  for (const [label, actual, expected] of checks) {
    line(`  ${String(actual).padStart(4)} / ${String(expected).padStart(4)}  ${actual === expected ? 'OK' : '<-- NIEZGODNE'}  ${label}`);
  }
  line(`  nierozwiązane: ${unresolved.length} (oczekiwano 1 — "zwiedzanie-winnicy-copy" — chyba że CSV zaktualizowany -> wtedy 0)`);
  line('');

  if (args.dryRun) {
    line('Tryb DRY-RUN: nic nie zapisano do Shopify, nic nie zacommitowano. Aby wykonać realny');
    line('zapis, uruchom z flagą --commit — dopiero po akceptacji tego wyniku.');
    return;
  }

  // ---------------------------------------------------------------------------- COMMIT

  if (doTagi) {
    console.log('Dodaję tagi...');
    for (const p of tagPlans) {
      await addTags(p.productId, p.tagsToAdd);
      console.log(`  OK ${p.storeHandle}: +[${p.tagsToAdd.join(', ')}]`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  if (doSeo) {
    console.log('Aktualizuję tytuły SEO...');
    for (const p of seoPlans) {
      await updateSeoTitle(p.productId, p.after);
      console.log(`  OK ${p.storeHandle}: "${p.after}"`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log('');
  console.log('Gotowe.');
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
