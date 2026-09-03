#!/usr/bin/env node
// Import 12 wydarzeń/voucherów/kart podarunkowych z wydarzenia-szablon-importu.xlsx
// (arkusz "Wydarzenia", 28 wierszy = 12 handle'i). Te produkty NIE ISTNIEJĄ w sklepie
// pod docelowymi handle'ami (2 z 12 kolidują z żywymi produktami — patrz raport Etapu 0
// w rozmowie — świadomie NIE pomijane w kodzie: jeśli --commit trafi na kolizję,
// productSet zwróci userError "Handle already exists" i skrypt przerwie się tam,
// zgodnie z polityką halt-on-error, zamiast cicho pomijać albo nadpisywać).
//
// Różnica architektoniczna względem import-zestawy.mjs (dwie fazy: productCreate +
// osobny metafieldsSet w paczkach po 4) — TU używamy `productSet` (jedna atomowa
// mutacja na produkt: tytuł, handle, opis, tagi, kategoria, templateSuffix, SEO,
// opcje+warianty+ceny+SKU, zdjęcia PRZEZ originalSource, i metapola custom.faq —
// wszystko w jednym wywołaniu). Powód: nasze produkty mają opcje/warianty/zdjęcia,
// których zestawy nie miały — productSet to rekomendowana przez Shopify mutacja do
// tworzenia złożonego produktu za jednym razem, unika stanu pośredniego "produkt
// istnieje, ale bez wariantów/zdjęć/faq", w który mogłaby wpaść dwufazowa metoda przy
// błędzie między fazami. `synchronous: true` wymuszone na każdym wywołaniu (limit
// wariantów w trybie synchronicznym z zapasem — max 8 wariantów w tym imporcie),
// żeby `product` w odpowiedzi był dostępny od razu (potrzebne do dedupu zdjęć, patrz
// niżej), bez pollingu jak przy `ProductSetOperation` w trybie async.
//
// UWAGA — brak scope inventory na tym tokenie (potwierdzone w Etapie 0: currentApp
// InstallationaccessScopes nie ma read_locations ani write_inventory). "Liczba miejsc"
// z arkusza NIE jest więc zapisywana jako inventoryQuantity — warianty powstają BEZ
// śledzenia zapasów (zawsze dostępne). Liczby miejsc lądują tylko w raporcie
// dry-run/commit jako "do uzupełnienia ręcznie w adminie po dodaniu scope".
//
// Dedup zdjęć (potwierdzone z klientem): pierwsze wystąpienie unikalnego URL-a z
// winnica-pmw.pl -> originalSource = ten URL wprost (Shopify pobiera sam, żaden
// lokalny download/staged upload nie jest potrzebny — FileSetInput.originalSource
// przyjmuje zewnętrzny URL). Każdy KOLEJNY produkt używający tego samego URL-a ->
// originalSource = CDN URL Shopify z pierwszego uploadu (z product.media pierwszego
// productSet) — unika powtórnego obciążania winnica-pmw.pl. Osobny rekord MediaImage
// nadal powstaje na każdym produkcie (ograniczenie API productCreateMedia/productSet —
// nie da się dosłownie podpiąć jednego MediaImage do wielu produktów), więc to
// ogranicza ZEWNĘTRZNE pobrania, nie liczbę wpisów w bibliotece Shopify. W DZISIEJSZYCH
// danych arkusza żaden URL nie występuje w więcej niż jednym produkcie (zweryfikowane
// programowo w Etapie 0) — ta ścieżka kodu jest więc przygotowana na przyszłość,
// nie ćwiczona przez bieżący import.
//
// FAQ: custom.faq (list.metaobject_reference -> pytanie_faq, ten sam typ co przy
// zestawach). Pytania z arkusza są NAJPIERW sprawdzane przeciw 115 istniejącym
// metaobiektom (dedupe po znormalizowanej treści pytania — wzorzec z import-zestawy.mjs),
// tworzone tylko brakujące. W dzisiejszych danych arkusza WSZYSTKIE 9 pytań (4 przy
// degustacja-wina, 5 przy malowanie-z-winem-w-plenerze-karta-podarunkowa) są nowe
// (zweryfikowane w Etapie 0) — kod i tak sprawdza, na wypadek gdyby arkusz się zmienił.
//
// Kategoria: gid://shopify/TaxonomyCategory/ae-1 ("Arts & Entertainment > Event
// Tickets") dla wszystkich 12 — arkusz podaje "Arts & Entertainment > Events", które
// NIE ISTNIEJE w taksonomii Shopify (zweryfikowane przez taxonomy.categories w Etapie 0);
// ae-1 to najbliższy realny liść, potwierdzony z klientem.
//
// Użycie:
//   node import-wydarzenia.mjs --file ./wydarzenia-szablon-importu.xlsx            (dry-run)
//   node import-wydarzenia.mjs --file ./wydarzenia-szablon-importu.xlsx --commit    (realny zapis)

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import xlsx from 'xlsx';
import { fetchAllMetaobjects } from './lib/fetch-metaobjects.mjs';

dotenv.config();

const API_VERSION = '2026-07'; // ujednolicone z resztą skryptów (patrz scripts/README lub audit-architektura.mjs) — było 2026-01
const SHEET_NAME = 'Wydarzenia';
const CATEGORY_EVENT_TICKETS = 'gid://shopify/TaxonomyCategory/ae-1'; // Arts & Entertainment > Event Tickets
const RATE_LIMIT_DELAY_MS = 550;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

// Kolizje handle rozwiązywane przez MERGE (productSet z identifier: {id}) zamiast
// CREATE — decyzja klienta po Etapie 0. Pozostałe 3 kolizje treściowe pod innymi
// handle'ami (w tym "-copy") kasowane ręcznie w adminie, poza zakresem tego skryptu.
//
// productSet traktuje `variants`, `productOptions` i `metafields` jako "pola
// listowe" — pełna zamiana zestawu, nie upsert (potwierdzone wprost w dokumentacji
// Shopify, nie domysł: "Creates new entries, updates existing entries, and deletes
// existing entries that aren't included in the mutation's input" — dotyczy TAKŻE
// metafields, niezależnie od namespace). Zweryfikowany stan obu produktów (Admin
// API, odczyt bezpośredni) przed napisaniem tego skryptu:
//   - zwiedzanie-winnicy: 3 warianty, wszystkie inventoryItem.tracked=true,
//     inventoryQuantity=20, requiresShipping=true (arkusz chce false). Wartości
//     opcji ("5.09"/"6.09"/"20.09") nie pokrywają się z żadną z 8 nowych z arkusza
//     ("05.09.2026" itd.) — merge usuwa WSZYSTKIE 3 obecne warianty (i ich
//     tracking/stan) i tworzy 8 nowych od zera. Metapola dziś na produkcie:
//     custom.tekst_seo, custom.faq (2 INNE pytania niż w arkuszu),
//     custom.harmonogram (4 punkty), plus judgeme.badge/widget/review_widget_data
//     (własność appki Judge.me).
//   - malowanie-z-winem-w-plenerze: 1 wariant "Default Title", tracked=true,
//     quantity=20, requiresShipping=false (już zgodne z arkuszem). Zastępowany
//     3 nowymi wariantami terminowymi. Metapola dziś: custom.data_wydarzenia,
//     custom.faq (1 INNE pytanie), custom.harmonogram (4 punkty — te same GID-y
//     co na zwiedzanie-winnicy i na produkcie Summer Sky&Wine, wygląda na wspólny/
//     uniwersalny harmonogram, nie unikalny), custom.tekst_seo (treść IDENTYCZNA
//     z opisem produktu Summer Sky&Wine — wygląda na błędne przypisanie w
//     istniejących danych, nie coś do naprawienia tym skryptem), plus
//     judgeme.badge/review_widget_data.
//
// Decyzje klienta po tym raporcie (patrz buildProductSetInput):
//   1. Re-supply AUTOMATYCZNY custom.tekst_seo/custom.harmonogram/custom.data_wydarzenia
//      (i dowolnych innych custom.* spoza arkusza) — nic z nich nie znika przy MERGE.
//   2. judgeme.* (badge/widget/review_widget_data) świadomie POMINIĘTE przy re-supply —
//      sprawdzone bezpośrednio: na obu produktach to czysty cache renderowania
//      zerowego stanu recenzji (number_of_reviews:0, reviews:[]), zero unikalnej
//      informacji, Judge.me odtworzy je sam.
//   3. custom.faq: REGUŁA "arkusz wygrywa, jeśli ma pytania dla danego handle'a;
//      jeśli arkusz jest pusty, zachowujemy istniejące FAQ produktu verbatim".
//      Zmiana decyzji po zobaczeniu, że oba produkty MERGE mają dziś realne,
//      wypełnione FAQ (2 i 1 pytanie), a arkusz nie ma dla nich ŻADNYCH pytań —
//      pierwotne "arkusz zawsze nadpisuje" skasowałoby tę treść bez zamiennika.
//      Reguła stosowana ogólnie do WSZYSTKICH produktów MERGE, nie tylko tych dwóch.
//   4. Nowe warianty dostają inventoryItem.tracked:false (spójne z pozostałymi
//      10 produktami CREATE) — odchodzi od dzisiejszego tracked:true, świadomie,
//      bo bez scope inventory nie da się i tak ustawić realnej ilości.
//   5. Brak scope read_orders zaakceptowany — sklep jest nowy, klient potwierdził
//      brak historii zamówień na tych wariantach.
const MERGE_HANDLES = new Set(['zwiedzanie-winnicy', 'malowanie-z-winem-w-plenerze']);

function parseArgs(argv) {
  const args = { dryRun: true, file: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--file') { args.file = argv[i + 1]; i++; }
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
  }
  return args;
}

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

function normalizeLabel(s) {
  return String(s).trim().toLowerCase();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shopifyGraphQL({ store, token, query, variables }) {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}
function isThrottled(json) {
  const codes = (json.errors ?? []).map((e) => e.extensions?.code);
  return codes.includes('THROTTLED');
}
async function graphqlRawWithRetry({ store, token, query, variables }) {
  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query, variables });
    if (isThrottled(json)) {
      if (attempt > MAX_RETRIES) throw new Error('Przekroczono limit prób po THROTTLED');
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    return json;
  }
}
async function graphqlWithRetry({ store, token, query, variables }) {
  const json = await graphqlRawWithRetry({ store, token, query, variables });
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// --- Wczytanie i grupowanie arkusza ---

function readRows(filePath) {
  const workbook = xlsx.readFile(filePath);
  if (!workbook.SheetNames.includes(SHEET_NAME)) {
    throw new Error(`Brak arkusza "${SHEET_NAME}". Dostępne: ${workbook.SheetNames.join(', ')}`);
  }
  return xlsx.utils.sheet_to_json(workbook.Sheets[SHEET_NAME], { defval: '' });
}

function groupByHandle(rows) {
  const order = [];
  const byHandle = new Map();
  for (const row of rows) {
    const handle = String(row['Handle']).trim();
    if (!handle) continue;
    if (!byHandle.has(handle)) {
      byHandle.set(handle, []);
      order.push(handle);
    }
    byHandle.get(handle).push(row);
  }
  return order.map((handle) => ({ handle, rows: byHandle.get(handle) }));
}

function parseFaqColumn(raw) {
  if (isBlank(raw)) return [];
  return String(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const idx = line.indexOf('|');
      if (idx === -1) throw new Error(`Wiersz FAQ bez separatora "|": "${line}"`);
      return { question: line.slice(0, idx).trim(), answer: line.slice(idx + 1).trim() };
    });
}

// product.karta z arkusza -> templateSuffix "voucher". Decyzja klienta: karty
// podarunkowe rezygnują z osobnego (i tak nieistniejącego, patrz Etap 0) szablonu
// product.karta i dzielą template z wydarzeniami cyklicznymi. sheetTemplateRaw
// zachowane osobno do raportu dry-run, żeby było widać, że to przemapowanie,
// nie literalny odczyt z arkusza.
const TEMPLATE_SUFFIX_MAP = {
  wydarzenie: 'wydarzenie',
  voucher: 'voucher',
  karta: 'voucher',
};

function buildProduct(group) {
  const first = group.rows[0];
  const handle = group.handle;
  const title = String(first['Tytuł produktu']).trim();
  const sheetTemplateRaw = String(first['Szablon']).trim().replace(/^product\./, '');
  const templateSuffix = TEMPLATE_SUFFIX_MAP[sheetTemplateRaw];
  if (!templateSuffix) {
    throw new Error(`${handle}: nieznana wartość "Szablon" = "${first['Szablon']}" — brak w TEMPLATE_SUFFIX_MAP.`);
  }
  const templateRemapped = sheetTemplateRaw !== templateSuffix;
  const tags = String(first['Tagi'])
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (normalizeLabel(first['Wymaga 18+']) === 'tak') tags.push('18+');

  const descriptionHtml = isBlank(first['Opis (HTML)']) ? null : String(first['Opis (HTML)']);
  const seoTitle = isBlank(first['SEO Title']) ? null : String(first['SEO Title']).trim();
  const seoDescription = isBlank(first['SEO Description']) ? null : String(first['SEO Description']).trim();

  const imageUrls = isBlank(first['Zdjęcia (URL, oddzielone przecinkami)'])
    ? []
    : String(first['Zdjęcia (URL, oddzielone przecinkami)']).split(',').map((u) => u.trim()).filter(Boolean);
  const imageAlt = isBlank(first['Opis alternatywny zdjęć']) ? null : String(first['Opis alternatywny zdjęć']).trim();

  const faq = parseFaqColumn(first['FAQ (pytanie | odpowiedź)']);

  const optionName = String(first['Nazwa opcji']).trim();
  const variants = group.rows.map((r) => {
    const inventoryRaw = r['Liczba miejsc'];
    return {
      optionValue: String(r['Wartość opcji']).trim(),
      price: Number(r['Cena brutto [zł]']),
      sku: isBlank(r['SKU']) ? null : String(r['SKU']).trim(),
      inventoryQuantityInfo: isBlank(inventoryRaw) ? null : Number(inventoryRaw),
    };
  });

  return {
    handle,
    title,
    templateSuffix,
    sheetTemplateRaw,
    templateRemapped,
    tags,
    descriptionHtml,
    seoTitle,
    seoDescription,
    imageUrls,
    imageAlt,
    faq,
    optionName,
    variants,
  };
}

// --- FAQ metaobiekty ---

const METAOBJECT_CREATE = /* GraphQL */ `
  mutation MmwMetaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

// Rozwiązuje GID-y metaobiektów pytanie_faq na treść pytania — używane do
// pokazania w raporcie dry-run, JAKIE konkretnie pytania znikają z produktu przy
// MERGE (custom.faq nadpisywane nową wartością z arkusza).
async function resolveMetaobjectQuestions({ store, token, gids }) {
  if (gids.length === 0) return [];
  const data = await graphqlWithRetry({
    store,
    token,
    query: /* GraphQL */ `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Metaobject {
            fields { key value }
          }
        }
      }
    `,
    variables: { ids: gids },
  });
  return data.nodes.map((n) => n.fields.find((f) => f.key === 'pytanie')?.value ?? '(brak pola pytanie)');
}

async function resolveFaqGids({ store, token, products, dryRun }) {
  console.log('\nPobieram istniejące pytanie_faq do sprawdzenia duplikatów...');
  const existing = await fetchAllMetaobjects({ store, token, graphql: graphqlRawWithRetry, type: 'pytanie_faq' });
  const faqMap = new Map(
    existing.map((m) => [normalizeLabel(m.fields.find((f) => f.key === 'pytanie')?.value ?? ''), m.id])
  );
  console.log(`  Znaleziono ${existing.length} istniejących pytań.`);

  const toCreate = [];
  for (const p of products) {
    for (const item of p.faq) {
      const key = normalizeLabel(item.question);
      if (!faqMap.has(key) && !toCreate.some((c) => normalizeLabel(c.question) === key)) {
        toCreate.push(item);
      }
    }
  }

  console.log(`  Nowych pytań do utworzenia: ${toCreate.length}`);
  for (const item of toCreate) console.log(`    - "${item.question}"`);

  if (dryRun || toCreate.length === 0) {
    // W dry-run nie tworzymy nic — zwracamy mapę z placeholderami, żeby dry-run
    // mógł pokazać liczbę GID-ów, jakie faktycznie trafią do custom.faq.
    for (const item of toCreate) faqMap.set(normalizeLabel(item.question), '(zostanie utworzone przy --commit)');
    return faqMap;
  }

  for (const item of toCreate) {
    const data = await graphqlWithRetry({
      store,
      token,
      query: METAOBJECT_CREATE,
      variables: {
        metaobject: {
          type: 'pytanie_faq',
          fields: [
            { key: 'pytanie', value: item.question },
            { key: 'odpowiedz', value: item.answer },
          ],
        },
      },
    });
    const userErrors = data.metaobjectCreate.userErrors;
    if (userErrors.length > 0) {
      throw new Error(`metaobjectCreate("${item.question}") userErrors: ${JSON.stringify(userErrors)}`);
    }
    faqMap.set(normalizeLabel(item.question), data.metaobjectCreate.metaobject.id);
    console.log(`  OK — utworzono metaobiekt dla: "${item.question}"`);
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return faqMap;
}

// --- productSet ---

const PRODUCT_SET_MUTATION = /* GraphQL */ `
  mutation MmwProductSet($input: ProductSetInput!, $synchronous: Boolean!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, synchronous: $synchronous, identifier: $identifier) {
      product {
        id
        handle
        media(first: 10) {
          nodes {
            ... on MediaImage {
              image { url }
            }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

function buildProductSetInput({ p, faqMap, imageUrlCache }) {
  const input = {
    title: p.title,
    handle: p.handle,
    status: 'DRAFT',
    category: CATEGORY_EVENT_TICKETS,
    tags: p.tags,
    templateSuffix: p.templateSuffix,
  };
  if (p.descriptionHtml) input.descriptionHtml = p.descriptionHtml;
  if (p.seoTitle || p.seoDescription) {
    input.seo = {};
    if (p.seoTitle) input.seo.title = p.seoTitle;
    if (p.seoDescription) input.seo.description = p.seoDescription;
  }

  input.productOptions = [
    {
      name: p.optionName,
      values: p.variants.map((v) => ({ name: v.optionValue })),
    },
  ];
  input.variants = p.variants.map((v) => ({
    optionValues: [{ optionName: p.optionName, name: v.optionValue }],
    price: v.price.toFixed(2),
    sku: v.sku ?? undefined,
    // tracked:false jawnie (decyzja klienta) — spójne z pozostałymi 10 produktami
    // CREATE, zamiast dziedziczyć tracked:true z produktów mergowanych (bez scope
    // inventory i tak nie da się ustawić realnej ilości >0, więc tracked:true
    // pokazywałoby 0 sztuk).
    inventoryItem: { requiresShipping: false, tracked: false },
  }));

  if (p.imageUrls.length > 0) {
    input.files = p.imageUrls.map((url) => ({
      originalSource: imageUrlCache.has(url) ? imageUrlCache.get(url) : url,
      contentType: 'IMAGE',
      alt: p.imageAlt ?? undefined,
    }));
  }

  // `metafields` w productSet to pole listowe — PEŁNA zamiana, nie upsert
  // (potwierdzone w dokumentacji Shopify). Przy MERGE trzeba więc re-supply'ować
  // metafields, jakie produkt ma dziś, żeby ich nie skasować — ale NIE wszystkie:
  // custom.faq z istniejącego jest wykluczony z TEGO ogólnego re-supply i liczony
  // OSOBNO niżej wg reguły "arkusz wygrywa, jeśli ma pytania; inaczej zachowujemy
  // istniejące" — a namespace `judgeme` jest świadomie POMINIĘTY —
  // sprawdzone bezpośrednio na obu produktach (Admin API): judgeme.badge to HTML
  // z data-number-of-reviews='0'/"No reviews", judgeme.widget to pusty "<div></div>",
  // judgeme.review_widget_data to JSON z number_of_reviews:0, reviews:[], histogram
  // same zera — dla OBU produktów. To czysty cache renderowania aktualnego (zerowego)
  // stanu recenzji, zero unikalnej informacji, którą Judge.me musiałby "pamiętać" —
  // prawdziwe recenzje żyją w backendzie Judge.me, nie w tych metapolach, więc apka
  // odtworzy je przy najbliższym przeliczeniu niezależnie od mechanizmu (webhook/
  // sync/reinstall widgetu) — nie znalazłam autorytatywnej dokumentacji Judge.me
  // opisującej WPROST ten mechanizm regeneracji, ale treść tych trzech metapól nie
  // niesie dziś nic wartego zachowania, więc ryzyko pominięcia jest minimalne
  // niezależnie od szczegółów tego mechanizmu.
  const faqGids = p.faq.map((item) => faqMap.get(normalizeLabel(item.question))).filter(Boolean);
  const metafields = [];
  if (p.mode === 'MERGE') {
    for (const mf of p.existingMetafields) {
      if (mf.namespace === 'custom' && mf.key === 'faq') continue; // nadpisywane niżej
      if (mf.namespace === 'judgeme') continue; // cache widżetu recenzji, odbudowywany przez apkę
      metafields.push({ namespace: mf.namespace, key: mf.key, type: mf.type, value: mf.value });
    }
  }
  // custom.faq: arkusz wygrywa, jeśli ma dla tego handle'a pytania. Jeśli arkusz
  // jest pusty (typowe dla MERGE — te dwa produkty nie mają dziś FAQ w arkuszu)
  // i produkt ma istniejące custom.faq, zachowujemy istniejącą wartość verbatim
  // zamiast ją kasować przez pominięcie. Decyzja klienta po zobaczeniu, że arkusz
  // skasowałby realne, wypełnione FAQ na obu produktach MERGE.
  if (faqGids.length > 0) {
    metafields.push({ namespace: 'custom', key: 'faq', type: 'list.metaobject_reference', value: JSON.stringify(faqGids) });
  } else if (p.mode === 'MERGE') {
    const existingFaq = p.existingMetafields.find((mf) => mf.namespace === 'custom' && mf.key === 'faq');
    if (existingFaq) {
      metafields.push({ namespace: 'custom', key: 'faq', type: existingFaq.type, value: existingFaq.value });
    }
  }
  if (metafields.length > 0) input.metafields = metafields;

  return input;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Brak pliku wejściowego. Użycie: node import-wydarzenia.mjs --file <ścieżka.xlsx> [--commit]');
    process.exit(1);
  }
  const filePath = path.resolve(args.file);
  if (!existsSync(filePath)) {
    console.error(`Plik nie istnieje: ${filePath}`);
    process.exit(1);
  }
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w .env.');
    process.exit(1);
  }

  console.log(args.dryRun ? 'Tryb: DRY-RUN (bez zapisu do Shopify)' : 'Tryb: COMMIT (realny zapis, status: DRAFT)');
  console.log('');

  const rows = readRows(filePath);
  const groups = groupByHandle(rows);
  console.log(`Wczytano ${rows.length} wierszy, ${groups.length} unikalnych handle'i.`);

  const products = groups.map(buildProduct);

  console.log('\nSprawdzam istniejące produkty pod docelowymi handle (CREATE vs MERGE)...');
  for (const p of products) {
    if (!MERGE_HANDLES.has(p.handle)) {
      p.mode = 'CREATE';
      continue;
    }
    const data = await graphqlWithRetry({
      store,
      token,
      query: /* GraphQL */ `
        query($handle: String!) {
          productByHandle(handle: $handle) {
            id
            metafields(first: 50) { nodes { namespace key value type } }
          }
        }
      `,
      variables: { handle: p.handle },
    });
    const existing = data.productByHandle;
    if (!existing) {
      throw new Error(`${p.handle}: oznaczony jako MERGE, ale nie znaleziono istniejącego produktu pod tym handle — sprawdź, czy ktoś go już usunął.`);
    }
    p.mode = 'MERGE';
    p.existingId = existing.id;
    p.existingMetafields = existing.metafields.nodes;
    await sleep(150);
  }

  const faqMap = await resolveFaqGids({ store, token, products, dryRun: args.dryRun });

  console.log('\n--- Plan (dry-run) ---');
  for (const p of products) {
    const modeLabel = p.mode === 'MERGE' ? `[MERGE -> ${p.existingId}]` : '[CREATE]';
    console.log(`\n${modeLabel} ${p.handle} (${p.title})`);
    if (p.templateRemapped) {
      console.log(`  templateSuffix: ${p.templateSuffix} (arkusz mówił "${p.sheetTemplateRaw}" — przemapowane na decyzję klienta: karty podarunkowe dzielą template z voucherami) | kategoria: ${CATEGORY_EVENT_TICKETS}`);
    } else {
      console.log(`  templateSuffix: ${p.templateSuffix} | kategoria: ${CATEGORY_EVENT_TICKETS}`);
    }
    console.log(`  tagi: ${p.tags.join(', ')}`);
    console.log(`  opis: ${p.descriptionHtml ? p.descriptionHtml.length + ' znaków' : '(brak — oczekiwane)'}`);
    console.log(`  SEO: ${p.seoTitle || p.seoDescription ? 'title/description obecne' : '(brak)'}`);
    console.log(`  zdjęcia: ${p.imageUrls.length}${p.imageUrls.length > 0 ? ` (alt: "${p.imageAlt}")` : ''}`);
    console.log(`  FAQ: ${p.faq.length} pytań`);
    console.log(`  warianty (${p.variants.length}), opcja "${p.optionName}":`);
    for (const v of p.variants) {
      const inv = v.inventoryQuantityInfo === null ? '(brak w arkuszu)' : `${v.inventoryQuantityInfo} — NIE ZAPISYWANE (brak scope inventory)`;
      console.log(`    - ${v.optionValue} | ${v.price.toFixed(2)} zł | sku=${v.sku ?? '(brak)'} | miejsca: ${inv}`);
    }
    if (p.mode === 'MERGE') {
      console.log(`  MERGE — obecne warianty i opcje produktu ZOSTANĄ ZASTĄPIONE wyżej wypisanym zestawem (productSet, pole listowe).`);
      const skippedJudgeme = p.existingMetafields.filter((mf) => mf.namespace === 'judgeme');
      const resupplied = p.existingMetafields.filter(
        (mf) => !(mf.namespace === 'custom' && mf.key === 'faq') && mf.namespace !== 'judgeme'
      );
      console.log(`  MERGE — re-supply ${resupplied.length} istniejących metapól, żeby ich nie skasować: ${resupplied.map((mf) => `${mf.namespace}.${mf.key}`).join(', ')}`);
      console.log(`  MERGE — POMINIĘTE (cache widżetu Judge.me, zero unikalnych danych — patrz komentarz w buildProductSetInput): ${skippedJudgeme.map((mf) => `${mf.namespace}.${mf.key}`).join(', ')}`);
      const oldFaq = p.existingMetafields.find((mf) => mf.namespace === 'custom' && mf.key === 'faq');
      const oldGids = oldFaq ? JSON.parse(oldFaq.value) : [];
      if (p.faq.length > 0) {
        // Arkusz wygrywa — jeśli istniało stare FAQ, zostaje nadpisane.
        console.log(`  MERGE — custom.faq PO ZAPISIE: ${p.faq.length} pytań, źródło: ARKUSZ (wygrywa nad istniejącym FAQ).`);
        if (oldGids.length > 0) {
          const oldQuestions = await resolveMetaobjectQuestions({ store, token, gids: oldGids });
          console.log(`    Nadpisane stare (${oldGids.length}): ${oldQuestions.map((q) => `"${q}"`).join('; ')}`);
        }
      } else if (oldGids.length > 0) {
        // Arkusz pusty — zachowujemy istniejące custom.faq verbatim.
        const oldQuestions = await resolveMetaobjectQuestions({ store, token, gids: oldGids });
        console.log(`  MERGE — custom.faq PO ZAPISIE: ${oldGids.length} pytań, źródło: ZACHOWANE Z PRODUKTU (arkusz pusty dla tego handle'a).`);
        console.log(`    Pytania: ${oldQuestions.map((q) => `"${q}"`).join('; ')}`);
      } else {
        console.log('  MERGE — custom.faq PO ZAPISIE: 0 pytań (arkusz pusty, produkt nie miał wcześniej FAQ).');
      }
    }
  }

  const createCount = products.filter((p) => p.mode === 'CREATE').length;
  const mergeCount = products.filter((p) => p.mode === 'MERGE').length;
  console.log(`\n\nPodsumowanie: ${products.length} produktów (${createCount} CREATE, ${mergeCount} MERGE), ${products.reduce((a, p) => a + p.variants.length, 0)} wariantów łącznie.`);
  console.log('UWAGA: żaden wariant nie dostanie śledzenia zapasów — brak scope read_locations/write_inventory na tokenie (patrz komentarz na górze pliku).');

  if (args.dryRun) {
    console.log('\nDry-run zakończony. Aby zapisać, uruchom z flagą --commit.');
    return;
  }

  console.log('\n=== Tworzenie/merge produktów (productSet, status: DRAFT) ===');
  const imageUrlCache = new Map(); // oryginalny URL winnica-pmw.pl -> Shopify CDN URL pierwszego uploadu
  const created = [];
  for (const p of products) {
    const input = buildProductSetInput({ p, faqMap, imageUrlCache });
    const variables = { input, synchronous: true };
    if (p.mode === 'MERGE') variables.identifier = { id: p.existingId };
    const data = await graphqlWithRetry({
      store,
      token,
      query: PRODUCT_SET_MUTATION,
      variables,
    });
    const userErrors = data.productSet.userErrors;
    if (userErrors.length > 0) {
      console.log(`  BŁĄD (${p.handle}): ${JSON.stringify(userErrors, null, 2)}`);
      console.log('  Przerywam — kolejne produkty NIE są tworzone/mergeowane.');
      process.exitCode = 1;
      return;
    }
    const product = data.productSet.product;
    console.log(`  OK [${p.mode}] — ${p.handle}: ${product.id}`);
    created.push(product);

    // Zasil cache URL-i obrazów pierwszym rzeczywistym uploadem, żeby kolejne
    // produkty z tym samym źródłowym URL-em dopinały się przez CDN Shopify,
    // nie przez ponowne pobranie z winnica-pmw.pl (patrz komentarz na górze pliku).
    if (p.imageUrls.length > 0) {
      const uploadedUrls = product.media.nodes.map((n) => n.image?.url).filter(Boolean);
      p.imageUrls.forEach((originalUrl, i) => {
        if (!imageUrlCache.has(originalUrl) && uploadedUrls[i]) {
          imageUrlCache.set(originalUrl, uploadedUrls[i]);
        }
      });
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`\nGotowe. Utworzono ${created.length} produktów (status: DRAFT).`);
  console.log('Przypomnienie: żaden nie jest opublikowany w kanale Sklep internetowy, żaden nie ma śledzenia zapasów.');
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
