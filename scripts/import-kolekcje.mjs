#!/usr/bin/env node
// Import kolekcji (Smart + Custom) z eksportu Matrixify (2_kolekcje.xlsx) do Shopify przez
// Admin GraphQL API. Zamiennik ręcznego tworzenia 35 kolekcji w adminie po audycie
// (scripts/audit-architektura.mjs).
//
// Dry-run domyślnie — zapis wyłącznie z --commit.
//
// Użycie:
//   node import-kolekcje.mjs --file ./import-marek/2_kolekcje.xlsx --remap ./import-marek/remap-handle.csv
//   node import-kolekcje.mjs --file ... --remap ... --commit
//
// ---------------------------------------------------------------------------------------
// WAŻNE — odkryte przy pisaniu tego skryptu (introspekcja schematu + odczyt żywego sklepu,
// 2026-09-03), NIE opisane w żadnym docu w repo: Admin API 2026-07 NIE MA już mutacji
// `collectionAddProducts`/`collectionRemoveProducts` (obie `isDeprecated: true`) ani pola
// `ruleSet`/`products` jako argumentu mutacji `collectionCreate`/`collectionUpdate` — obie
// mutacje przyjmują dziś WYŁĄCZNIE argument `collection` (typu `CollectionCreateInput` /
// `CollectionUpdateInput`), nie ma już argumentu `input`. Cały model członkostwa (ręczna
// lista I reguły tagowe) przeszedł na "sources": kolekcja ma listę `CollectionConditionsSource`,
// każde źródło ma `inclusion.selections` (ręczne produkty, `{ productId }`) i/lub
// `inclusion.conditions` (reguły, np. `productTag`). Dodawanie produktów do ISTNIEJĄCEJ
// kolekcji idzie przez `collectionUpdate` → `sourcesToUpdate: [{ condition: { id: <sourceId>,
// selectionsToAdd: [...] } }]` — trzeba więc najpierw odczytać ID istniejącego źródła
// manualnego. Zweryfikowane bezpośrednio (introspekcja + odczyt `zestawy-prezentowe` i
// `wydarzenia` na żywym sklepie: każda ma dokładnie jedno źródło typu PRODUCTS z listą
// `selections`), nie teoria.
//
// `ruleSet` NADAL działa jako pole do ODCZYTU (legacy, mapowane z sources pod spodem) —
// używane niżej wyłącznie do klasyfikacji smart/custom przy detekcji konfliktów typu.
//
// Konsekwencja dla tworzenia kolekcji ręcznych: nowy schemat pozwala przekazać listę
// produktów RAZEM z `collectionCreate` (w `sources[0].source.inclusion.selections`) —
// nie trzeba osobnego kroku "utwórz pustą, potem dodaj produkty", jak sugerowałby starszy
// model API. Ten skrypt korzysta z tego uproszczenia.
// ---------------------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import xlsx from 'xlsx';
import { shopifyGraphQLWithRetry, sleep } from './lib/shopify-graphql.mjs';

// .env leży w scripts/.env, niezależnie od cwd uruchomienia (patrz audit-architektura.mjs).
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

if (!STORE || !TOKEN) {
  console.error('Brak SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN w scripts/.env');
  process.exit(1);
}

const PAGE_SIZE = 250;
const RATE_LIMIT_DELAY_MS = 550;

// ZAKAZ nr 4: klient wycofał nazewnictwo "vouchery" — ten handle ze Smart Collections jest
// pomijany bezwarunkowo, bez wyjątków.
const SKIP_SMART_HANDLES = new Set(['vouchery']);

const SORT_ORDER_MAP = { 'Best Selling': 'BEST_SELLING' };

function parseArgs(argv) {
  const args = { dryRun: true, file: null, remap: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else if (a === '--remap') args.remap = argv[++i];
    else if (a.startsWith('--remap=')) args.remap = a.slice('--remap='.length);
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

function mapSortOrder(raw) {
  const r = norm(raw);
  if (!r) return null;
  const mapped = SORT_ORDER_MAP[r];
  if (!mapped) {
    throw new Error(`Nieznana wartość "Sort Order": "${r}" — brak mapowania w SORT_ORDER_MAP. Uzupełnij mapowanie przed importem.`);
  }
  return mapped;
}

// ---------------------------------------------------------------------------------- XLSX / CSV

function readSheet(filePath, sheetName) {
  const wb = xlsx.readFile(filePath);
  if (!wb.SheetNames.includes(sheetName)) {
    throw new Error(`Brak arkusza "${sheetName}" w ${filePath}. Dostępne: ${wb.SheetNames.join(', ')}`);
  }
  return xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

// Prosty parser CSV z obsługą cudzysłowów — remap-handle.csv dziś nie ma cudzysłowów/przecinków
// w polach, ale to plik generowany z tytułów produktów (patrz audit-architektura.mjs, csvEscape),
// więc przecinek w tytule przy kolejnym przebiegu audytu jest realnym scenariuszem.
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
  const map = new Map(); // handle -> { id, handle, title }
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($cursor: String) {
        products(first: ${PAGE_SIZE}, after: $cursor) {
          nodes { id handle title }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor }
    );
    for (const n of data.products.nodes) map.set(n.handle, n);
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return map;
}

async function fetchAllCollectionsLight() {
  const map = new Map(); // handle -> { id, handle, title, isSmart }
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($cursor: String) {
        collections(first: ${PAGE_SIZE}, after: $cursor) {
          nodes { id handle title ruleSet { appliedDisjunctively } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor }
    );
    for (const n of data.collections.nodes) {
      map.set(n.handle, { id: n.id, handle: n.handle, title: n.title, isSmart: !!n.ruleSet });
    }
    if (!data.collections.pageInfo.hasNextPage) break;
    cursor = data.collections.pageInfo.endCursor;
  }
  return map;
}

// Pełne dane potrzebne wyłącznie dla kolekcji ISTNIEJĄCYCH RĘCZNYCH do aktualizacji: lista
// aktualnych produktów (do liczenia różnicy) + id jedynego źródła manualnego (do
// collectionUpdate -> sourcesToUpdate, patrz komentarz o "sources" na górze pliku).
async function fetchCollectionDetail(id) {
  const productHandles = [];
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: ${PAGE_SIZE}, after: $cursor) {
            nodes { handle }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id, cursor }
    );
    for (const n of data.collection.products.nodes) productHandles.push(n.handle);
    if (!data.collection.products.pageInfo.hasNextPage) break;
    cursor = data.collection.products.pageInfo.endCursor;
  }

  const sourceData = await gql(
    `query($id: ID!) {
      collection(id: $id) {
        sources { id }
      }
    }`,
    { id }
  );

  return { productHandles, sources: sourceData.collection.sources };
}

async function fetchOnlineStorePublicationId() {
  const data = await gql(`{ publications(first: 20) { nodes { id name } } }`);
  const pub = data.publications.nodes.find((p) => p.name === 'Online Store');
  return pub?.id ?? null;
}

// ---------------------------------------------------------------------------------- Krok 1: wczytanie i normalizacja

function buildSmartCollections(rowsSC) {
  const items = [];
  const skippedVouchery = [];
  for (const r of rowsSC) {
    const handle = norm(r['Handle']);
    if (!handle) continue;
    if (SKIP_SMART_HANDLES.has(handle)) {
      skippedVouchery.push(handle);
      continue;
    }
    items.push({
      handle,
      title: norm(r['Title']),
      descriptionHtml: norm(r['Body HTML']),
      seoTitle: norm(r['Metafield: title_tag']),
      seoDescription: norm(r['Metafield: description_tag']),
      sortOrderRaw: norm(r['Sort Order']),
      ruleCondition: norm(r['Rule: Condition']),
    });
  }
  return { items, skippedVouchery };
}

// Custom Collections: wiersze grupowane po Handle. Pierwszy wiersz danego handle (ten z
// wypełnionym Command) niesie metadane; KAŻDY wiersz (łącznie z tym pierwszym) może nieść
// Product: Handle — konwencja Matrixify zweryfikowana bezpośrednio na tym pliku (221/221
// wierszy ma wypełnione Product: Handle, w tym wszystkie 26 wierszy z Command).
function buildCustomCollections(rowsCC) {
  const byHandle = new Map();
  for (const r of rowsCC) {
    const handle = norm(r['Handle']);
    if (!handle) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, { handle, meta: null, productHandlesRaw: [] });
    const entry = byHandle.get(handle);
    if (norm(r['Command'])) entry.meta = r;
    const ph = norm(r['Product: Handle']);
    if (ph) entry.productHandlesRaw.push(ph);
  }
  return byHandle;
}

// ---------------------------------------------------------------------------------- Krok 3: mutacje (--commit)

// Zabezpieczenie na wprost, nie tylko przez konstrukcję resolveList(): produkt, którego nie
// ma w productMap, NIGDY nie trafia do Shopify jako null/sfabrykowany GID — mutacja rzuca
// błąd i przerywa import, zamiast po cichu wysłać niepełną listę (patrz zgłoszony bug
// Shopify: collectionUpdate/collectionCreate z choć jednym nieistniejącym produktem w
// selections może nie dodać ŻADNEGO produktu, mimo że mutacja zwraca sukces bez userErrors —
// więc wolimy głośny błąd PRZED wysłaniem niż ciche puste dodanie).
function productIdFor(handle, productMap) {
  const product = productMap.get(handle);
  if (!product) {
    throw new Error(
      `Wewnętrzny błąd: handle "${handle}" trafił do listy produktów do zapisania, mimo że nie ma go w productMap. To nie powinno się zdarzyć — resolveList() miało go odfiltrować. Zatrzymuję się, żeby nie wysłać do Shopify niekompletnej/błędnej listy selections.`
    );
  }
  return product.id;
}

async function createCustomCollection(entry, productMap) {
  const meta = entry.meta;
  const seo = {};
  const seoTitle = norm(meta?.['Metafield: title_tag']);
  const seoDesc = norm(meta?.['Metafield: description_tag']);
  if (seoTitle) seo.title = seoTitle;
  if (seoDesc) seo.description = seoDesc;
  const sortOrder = mapSortOrder(meta?.['Sort Order']);

  const collectionInput = {
    title: norm(meta?.Title),
    handle: entry.handle,
    descriptionHtml: norm(meta?.['Body HTML']),
  };
  if (Object.keys(seo).length) collectionInput.seo = seo;
  if (sortOrder) collectionInput.sortOrder = sortOrder;
  if (entry.resolvedProductHandles.length) {
    collectionInput.sources = [
      {
        source: {
          title: 'Ręczny wybór produktów',
          inclusion: {
            selections: entry.resolvedProductHandles.map((h) => ({ productId: productIdFor(h, productMap) })),
          },
        },
      },
    ];
  }

  const data = await gql(
    `mutation($collection: CollectionCreateInput!) {
      collectionCreate(collection: $collection) {
        collection { id handle }
        userErrors { field message }
      }
    }`,
    { collection: collectionInput }
  );
  const { collection, userErrors } = data.collectionCreate;
  if (userErrors.length) throw new Error(`collectionCreate(${entry.handle}): ${userErrors.map((e) => e.message).join('; ')}`);
  return collection;
}

async function createSmartCollection(item) {
  const seo = {};
  if (item.seoTitle) seo.title = item.seoTitle;
  if (item.seoDescription) seo.description = item.seoDescription;
  const sortOrder = mapSortOrder(item.sortOrderRaw);

  const collectionInput = {
    title: item.title,
    handle: item.handle,
    descriptionHtml: item.descriptionHtml,
    sources: [
      {
        source: {
          title: `Reguła: ${item.ruleCondition}`,
          inclusion: {
            matchType: 'ALL',
            conditions: [
              {
                productTag: { relation: 'TAGGED_WITH', matchType: 'ALL', values: [item.ruleCondition] },
              },
            ],
          },
        },
      },
    ],
  };
  if (Object.keys(seo).length) collectionInput.seo = seo;
  if (sortOrder) collectionInput.sortOrder = sortOrder;

  const data = await gql(
    `mutation($collection: CollectionCreateInput!) {
      collectionCreate(collection: $collection) {
        collection { id handle }
        userErrors { field message }
      }
    }`,
    { collection: collectionInput }
  );
  const { collection, userErrors } = data.collectionCreate;
  if (userErrors.length) throw new Error(`collectionCreate(${item.handle}): ${userErrors.map((e) => e.message).join('; ')}`);
  return collection;
}

async function publishCollection(id, publicationId) {
  const data = await gql(
    `mutation($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`,
    { id, input: [{ publicationId }] }
  );
  const errs = data.publishablePublish.userErrors;
  if (errs.length) throw new Error(`publishablePublish(${id}): ${errs.map((e) => e.message).join('; ')}`);
}

async function updateCollection(u, productMap) {
  const meta = u.entry.meta;
  const seo = {};
  const seoTitle = norm(meta?.['Metafield: title_tag']);
  const seoDesc = norm(meta?.['Metafield: description_tag']);
  if (seoTitle) seo.title = seoTitle;
  if (seoDesc) seo.description = seoDesc;
  const sortOrder = mapSortOrder(meta?.['Sort Order']);

  const collectionInput = { id: u.existing.id };
  const title = norm(meta?.Title);
  if (title) collectionInput.title = title;
  const desc = norm(meta?.['Body HTML']);
  if (desc) collectionInput.descriptionHtml = desc;
  if (Object.keys(seo).length) collectionInput.seo = seo;
  if (sortOrder) collectionInput.sortOrder = sortOrder;
  // ZAKAZ nr 3: wyłącznie dodawanie (selectionsToAdd), nigdy selectionsToRemove.
  if (u.toAdd.length) {
    collectionInput.sourcesToUpdate = [
      {
        condition: {
          id: u.sourceId,
          inclusion: {
            selectionsToAdd: u.toAdd.map((h) => ({ productId: productIdFor(h, productMap) })),
          },
        },
      },
    ];
  }

  const data = await gql(
    `mutation($collection: CollectionUpdateInput!) {
      collectionUpdate(collection: $collection) {
        collection { id handle }
        userErrors { field message }
      }
    }`,
    { collection: collectionInput }
  );
  const errs = data.collectionUpdate.userErrors;
  if (errs.length) throw new Error(`collectionUpdate(${u.handle}): ${errs.map((e) => e.message).join('; ')}`);
}

// ---------------------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !args.remap) {
    console.error('Użycie: node import-kolekcje.mjs --file <2_kolekcje.xlsx> --remap <remap-handle.csv> [--commit]');
    process.exit(1);
  }
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
  console.log('');

  const rowsSC = readSheet(filePath, 'Smart Collections');
  const rowsCC = readSheet(filePath, 'Custom Collections');
  const remapMap = readRemapCsv(remapPath);

  console.log(`Wczytano ${rowsSC.length} wierszy Smart Collections, ${rowsCC.length} wierszy Custom Collections.`);
  console.log(
    `remap-handle.csv: ${remapMap.size} wierszy, ${[...remapMap.values()].filter(Boolean).length} z wypełnionym proponowany_handle.`
  );
  console.log('');

  console.log('Pobieram stan sklepu (produkty, kolekcje, publikacje)...');
  const [productMap, collectionMap, onlineStorePublicationId] = await Promise.all([
    fetchAllProducts(),
    fetchAllCollectionsLight(),
    fetchOnlineStorePublicationId(),
  ]);
  console.log(`Produkty w sklepie: ${productMap.size} | Kolekcje w sklepie: ${collectionMap.size}`);

  if (!onlineStorePublicationId) {
    console.error('');
    console.error('BLOKADA: nie udało się odczytać ID publikacji "Online Store" (brak uprawnienia albo kanał nie istnieje).');
    console.error('Zatrzymuję się — bez tego ID nowe kolekcje powstałyby niewidoczne na sklepie.');
    process.exit(1);
  }
  console.log(`Publikacja "Online Store": ${onlineStorePublicationId}`);
  console.log('');

  const { items: smartItems, skippedVouchery } = buildSmartCollections(rowsSC);
  const customByHandle = buildCustomCollections(rowsCC);

  // --- partycja: create / update / konflikt typu -----------------------------------------
  const toCreateSmart = [];
  const toCreateCustom = [];
  const toUpdate = [];
  const conflicts = [];

  for (const item of smartItems) {
    const existing = collectionMap.get(item.handle);
    if (!existing) toCreateSmart.push(item);
    else if (existing.isSmart) toUpdate.push({ type: 'smart', handle: item.handle, existing, item });
    else conflicts.push({ handle: item.handle, problem: 'plik chce SMART, w sklepie istnieje RĘCZNA', existingTitle: existing.title });
  }

  for (const [handle, entry] of customByHandle) {
    const existing = collectionMap.get(handle);
    if (!existing) toCreateCustom.push(entry);
    else if (!existing.isSmart) toUpdate.push({ type: 'custom', handle, existing, entry });
    else conflicts.push({ handle, problem: 'plik chce RĘCZNĄ, w sklepie istnieje SMART', existingTitle: existing.title });
  }

  // --- rozwiązywanie handli produktów (Krok 1, zasada 3-krokowa z ZAKAZU nr 6) -----------
  const unresolved = []; // { kolekcja, handle }
  let resolvedDirect = 0;
  let resolvedRemap = 0;

  function resolveList(kolekcjaHandle, rawHandles) {
    const out = [];
    const seen = new Set();
    for (const raw of rawHandles) {
      let resolvedHandle = null;
      let via = null;
      if (productMap.has(raw)) {
        resolvedHandle = raw;
        via = 'wprost';
      } else {
        const mapped = remapMap.get(raw);
        if (mapped && productMap.has(mapped)) {
          resolvedHandle = mapped;
          via = 'remap';
        }
      }
      if (!resolvedHandle) {
        unresolved.push({ kolekcja: kolekcjaHandle, handle: raw });
        continue;
      }
      if (seen.has(resolvedHandle)) continue; // duplikat w pliku (ew. po remapie) — pomijamy cicho
      seen.add(resolvedHandle);
      out.push(resolvedHandle);
      if (via === 'wprost') resolvedDirect++;
      else resolvedRemap++;
    }
    return out;
  }

  for (const entry of toCreateCustom) {
    entry.resolvedProductHandles = resolveList(entry.handle, entry.productHandlesRaw);
  }

  const updateDetails = [];
  for (const u of toUpdate) {
    if (u.type === 'smart') {
      // Nie oczekiwane w danych z tego promptu (0 istniejących smart wśród kolizji) — jeśli
      // się pojawi, zgłaszamy zamiast cicho ignorować albo zgadywać, jak zaktualizować regułę.
      console.log(`UWAGA: kolekcja smart "${u.handle}" już istnieje w sklepie — ten skrypt nie aktualizuje reguł smart (poza zakresem tego zadania), pomijam.`);
      continue;
    }
    const desired = resolveList(u.handle, u.entry.productHandlesRaw);
    const detail = await fetchCollectionDetail(u.existing.id);
    if (detail.sources.length !== 1) {
      throw new Error(
        `Kolekcja "${u.handle}" ma ${detail.sources.length} źródeł (oczekiwano dokładnie 1 manualnego) — skrypt nie wie, do którego dopisać produkty. Zatrzymuję się, żeby nie zgadywać.`
      );
    }
    const existingSet = new Set(detail.productHandles);
    const toAdd = desired.filter((h) => !existingSet.has(h));
    updateDetails.push({
      handle: u.handle,
      existing: u.existing,
      entry: u.entry,
      existingProductHandles: detail.productHandles,
      desiredProductHandles: desired,
      toAdd,
      sourceId: detail.sources[0].id,
    });
  }

  // ---------------------------------------------------------------------------- RAPORT (Krok 4/5)

  const line = (s = '') => console.log(s);

  line('='.repeat(70));
  line('UWAGA — ZMIANA W SCHEMACIE ADMIN API (odkryte przy pisaniu tego skryptu)');
  line('='.repeat(70));
  line('API 2026-07 nie ma już mutacji collectionAddProducts/collectionRemoveProducts ani');
  line('ruleSet/products jako argumentów collectionCreate/collectionUpdate (mutacje przyjmują');
  line('wyłącznie argument "collection"). Model produktowy przeszedł na "sources" —');
  line('collectionUpdate dodaje produkty przez sourcesToUpdate.condition.selectionsToAdd.');
  line('Kod --commit w tym skrypcie jest napisany pod ten nowy schemat (zweryfikowane');
  line('introspekcją + odczytem żywych kolekcji zestawy-prezentowe/wydarzenia), NIE pod');
  line('mapowanie z promptu (collectionAddProducts/ruleSet jako argument mutacji).');
  line('');

  line('='.repeat(70));
  line('PODSUMOWANIE');
  line('='.repeat(70));
  line(`Kolekcje do utworzenia: ${toCreateSmart.length + toCreateCustom.length} (smart: ${toCreateSmart.length}, custom: ${toCreateCustom.length})`);
  line(`Kolekcje do aktualizacji: ${updateDetails.length}`);
  line(`Kolekcje ręczne w pliku (Custom Collections, unikalne handle): ${customByHandle.size}`);
  line(`Wiersze w Custom Collections: ${rowsCC.length}`);
  line(`Pominięte z Smart Collections (vouchery): ${skippedVouchery.length}`);
  line(`Produkty rozwiązane wprost: ${resolvedDirect}`);
  line(`Produkty rozwiązane przez remap: ${resolvedRemap}`);
  const unresolvedUniqueHandles = new Set(unresolved.map((u) => u.handle));
  line(`Produkty nierozwiązane: ${unresolved.length} wystąpień / ${unresolvedUniqueHandles.size} unikalnych handli (ten sam handle może brakować w kilku kolekcjach naraz)`);
  if (conflicts.length) line(`KONFLIKTY TYPU: ${conflicts.length}`);
  line('');

  line('='.repeat(70));
  line(`KOLEKCJE DO UTWORZENIA (${toCreateSmart.length + toCreateCustom.length})`);
  line('='.repeat(70));
  for (const item of toCreateSmart) {
    line(`  + [smart]  ${item.handle}  "${item.title}"  reguła: ${item.ruleCondition}  (produkty: auto wg tagu, po imporcie tagów)`);
  }
  for (const entry of toCreateCustom) {
    line(`  + [custom] ${entry.handle}  "${norm(entry.meta?.Title)}"  produktów do przypisania: ${entry.resolvedProductHandles.length}`);
  }
  line('');

  line('='.repeat(70));
  line(`KOLEKCJE DO AKTUALIZACJI (${updateDetails.length})`);
  line('='.repeat(70));
  for (const u of updateDetails) {
    const newTitle = norm(u.entry.meta?.Title);
    line(`  ~ ${u.handle}`);
    line(`      tytuł:     "${u.existing.title}"  ->  "${newTitle || '(bez zmian, puste w pliku)'}"`);
    line(
      `      produkty:  ${u.existingProductHandles.length} obecnie  ->  ${u.existingProductHandles.length + u.toAdd.length} po imporcie  (+${u.toAdd.length} nowych)`
    );
    if (u.toAdd.length) {
      line(`      dodawane produkty:`);
      u.toAdd.forEach((h) => line(`        - ${h}`));
    }
  }
  line('');

  if (conflicts.length) {
    line('='.repeat(70));
    line(`KONFLIKTY TYPU (${conflicts.length}) — pominięte, wymagają decyzji ręcznej`);
    line('='.repeat(70));
    conflicts.forEach((c) => line(`  ! ${c.handle}: ${c.problem} ("${c.existingTitle}")`));
    line('');
  }

  line('='.repeat(70));
  line(`PRODUKTY NIEROZWIĄZANE (${unresolved.length})`);
  line('='.repeat(70));
  if (unresolved.length === 0) line('  (brak)');
  unresolved.forEach((u) => line(`  - ${u.handle}  (w kolekcji: ${u.kolekcja})`));
  line('');

  line('='.repeat(70));
  line('POMINIĘCIA WEDŁUG ZAKAZÓW');
  line('='.repeat(70));
  line(`  "vouchery" pominięte z Smart Collections: ${skippedVouchery.length > 0 ? 'TAK' : 'NIE — UWAGA, sprawdź plik źródłowy'}`);
  line('');

  line('='.repeat(70));
  line('WERYFIKACJA WOBEC OCZEKIWANYCH WARTOŚCI Z PROMPTU');
  line('='.repeat(70));
  const checks = [
    ['kolekcje do utworzenia', toCreateSmart.length + toCreateCustom.length, 34],
    ['kolekcje do aktualizacji', updateDetails.length, 2],
    ['kolekcje ręczne w pliku', customByHandle.size, 26],
    ['wiersze w Custom Collections', rowsCC.length, 221],
  ];
  for (const [label, actual, expected] of checks) {
    line(`  ${String(actual).padStart(4)} / ${String(expected).padStart(4)}  ${actual === expected ? 'OK' : '<-- NIEZGODNE'}  ${label}`);
  }
  line(
    `  produkty nierozwiązane: ${unresolvedUniqueHandles.size} unikalnych handli / ${unresolved.length} wystąpień (oczekiwano 1 unikalnego handla — "zwiedzanie-winnicy-copy" — który w tym pliku występuje w ${unresolved.length} różnych kolekcjach naraz, stąd więcej niż 1 wystąpienie; chyba że CSV zaktualizowany w międzyczasie -> wtedy 0)`
  );
  line('');

  if (args.dryRun) {
    line('Tryb DRY-RUN: nic nie zapisano do Shopify, nic nie zacommitowano. Aby wykonać realny');
    line('zapis, uruchom z flagą --commit — dopiero po akceptacji tego wyniku.');
    return;
  }

  // ---------------------------------------------------------------------------- COMMIT (Krok 3)
  // Kolejność: najpierw kolekcje ręczne (create + update), potem automatyczne (smart) —
  // smart i tak zapełnią się same wg tagów, więc kolejność między nimi a ręcznymi nie ma
  // znaczenia funkcjonalnego, ale trzymamy się kolejności z promptu.

  console.log('Tworzę kolekcje ręczne...');
  for (const entry of toCreateCustom) {
    const c = await createCustomCollection(entry, productMap);
    await publishCollection(c.id, onlineStorePublicationId);
    console.log(`  OK ${entry.handle}`);
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log('Aktualizuję istniejące kolekcje ręczne...');
  for (const u of updateDetails) {
    await updateCollection(u, productMap);
    console.log(`  OK ${u.handle}`);
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log('Tworzę kolekcje smart...');
  for (const item of toCreateSmart) {
    const c = await createSmartCollection(item);
    await publishCollection(c.id, onlineStorePublicationId);
    console.log(`  OK ${item.handle}`);
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log('');
  console.log('Gotowe.');
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
