#!/usr/bin/env node
// Dograbuje przez Admin API brakujące dane do ISTNIEJĄCYCH produktów-win:
// skale sensoryczne (custom.skale), typ wina (custom.typ_wina), przechowywanie
// (custom.przechowywanie), wartości odżywcze i alergeny
// (custom.wartosci_odzywcze_i_alergeny), dominujące nuty (custom.dominujace_nuty)
// i tekst SEO (custom.tekst_seo — patrz STALE_SEO_TEXT_SIGNATURE niżej za
// regułę nadpisywania). Wzorowany na scripts/assign-pairings.mjs (ten sam
// kształt: dry-run domyślny, --commit do zapisu, xlsx/SheetJS, ten sam styl
// logowania i obsługi błędów).
//
// NIE tworzy produktów ani metaobiektów (poza jednorazowym, ręcznym
// utworzeniem skali "Wygląd (różowe)" opisanym w raporcie Etapu 0 — to było
// zrobione RAZ, poza tym skryptem, na wyraźną zgodę). Nie rusza tytułów,
// opisów, kategorii, wariantów, zdjęć ani statusu produktu — wyłącznie sześć
// metapól z zakresu.
//
// Użycie:
//   node import-wina.mjs --file ./produkty-wina.xlsx            (dry-run, domyślnie)
//   node import-wina.mjs --file ./produkty-wina.xlsx --commit    (realny zapis)

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import xlsx from 'xlsx';
import { resolveMetaobjectGid } from './lib/resolve-metaobject-handle.mjs';

dotenv.config();

const API_VERSION = '2026-07';
const SHEET_NAME = 'Dane';

const COL_HANDLE = 'Handle';
const COL_ROW_TYPE = 'Typ wiersza';
const COL_TYP_WINA = 'Typ wina';
const COL_TEKST_SEO = 'Tekst SEO';
const COL_PRZECHOWYWANIE = 'Przechowywanie';
const COL_WARTOSCI_ODZYWCZE = 'Wartości odżywcze i alergeny';
const COL_DOMINUJACE_NUTY = 'Dominujące nuty';
const ROW_TYPE_WZOR = 'WZÓR';

// Treść wpisana w komórkę "Tekst SEO" wiersza WZÓR, która przez wcześniejszy
// błędny proces wylądowała identycznie na WSZYSTKICH 15 produktach w zakresie
// tego importu — potwierdzone bezpośrednim odczytem z Admin API. Traktowana
// jako rozpoznany błąd, nie "istniejąca treść" — jedyny wyjątek od reguły
// "nie nadpisuj niepustego pola" (decyzja użytkownika). Każda INNA, niepusta
// wartość custom.tekst_seo nadal zostaje nietknięta bez wyjątków.
//
// Porównanie idzie po znormalizowanym tekście (whitespace collapsed do
// pojedynczej spacji), NIE po surowym JSON-ie bajt-w-bajt: pierwsza próba
// z literałem string skopiowanym z terminala zawiodła, bo żywa wartość
// zawiera niełamliwą spację (U+00A0, polska reguła typograficzna "w/i/z" na
// końcu linii) w miejscu, gdzie w terminalu wygląda identycznie jak zwykła
// spacja — string-literal był po cichu okaleczony przy kopiowaniu.
const STALE_SEO_TEXT_SIGNATURE = normalizeWhitespace(
  'Blanc 2025 Wino z Winnicy Mała Wieś Każdy rok w winiarstwie to nowe wyzwania. Mazowsze w 2024 roku obdarzyło nas doskonałymi warunkami pogodowymi. Ciepłe lato i brak wiosennych przymrozków pozwoliły uzyskać wino o złożonym charakterze, głębokich nutach owocowych i subtelnym, mineralnym finiszu.'
);

function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Wyciąga cały tekst z węzłów "text" rich_text_field (JSON string), niezależnie od struktury/typu węzłów nadrzędnych. */
function extractRichTextPlain(jsonValue) {
  let parsed;
  try {
    parsed = JSON.parse(jsonValue);
  } catch {
    return null;
  }
  const parts = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.value === 'string' && node.type === 'text') parts.push(node.value);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  walk(parsed);
  return normalizeWhitespace(parts.join(' '));
}

function isStaleSeoPlaceholder(currentSeoJson) {
  if (!currentSeoJson) return false;
  const plain = extractRichTextPlain(currentSeoJson);
  return plain === STALE_SEO_TEXT_SIGNATURE;
}

// Kolumna Wygląd(...) -> handle skali skala_sensoryczna. Zweryfikowane przez
// Admin API w Etapie 0b, nie wyprowadzone z etykiet (patrz przypomnienie o
// rozjeździe kwasnosc/kwasowosc).
const WYGLAD_COLUMN_TO_AXIS = {
  'Wygląd (białe)': 'wyglad-wina-biale',
  'Wygląd (różowe)': 'wyglad-wina-rozowe',
  'Wygląd (czerwone)': 'wyglad-wina-czerwone',
};

const OTHER_AXIS_COLUMNS = {
  Aromat: 'aromat',
  Kwasowość: 'kwasowosc',
  Ciało: 'cialo',
};

// Handle poziom_skali per (oś, wartość) — słowne, nie dają się wyprowadzić
// z samej liczby. Zweryfikowane przez Admin API w Etapie 0b. wyglad-wina-rozowe
// ma tylko 2 poziomy (utworzone ręcznie po decyzji z Etapu 0 — patrz raport).
const LEVEL_HANDLES = {
  'wyglad-wina-biale': { 1: 'wyglad-biale-slomkowy', 2: 'wyglad-biale-zlocisty', 3: 'wyglad-biale-bursztynowy' },
  'wyglad-wina-czerwone': { 1: 'wyglad-czerwone-rubinowy', 2: 'wyglad-czerwone-purpurowy', 3: 'wyglad-czerwone-ceglasty' },
  'wyglad-wina-rozowe': { 1: 'wyglad-rozowe-lososiowy', 2: 'wyglad-rozowe-magenta' },
  aromat: { 1: 'aromat-delikatny', 2: 'aromat-srednio-intensywny', 3: 'aromat-bardzo-intensywny' },
  kwasowosc: { 1: 'kwasowosc-niska', 2: 'kwasowosc-srednia', 3: 'kwasowosc-wysoka' },
  cialo: { 1: 'cialo-lekkie', 2: 'cialo-srednie', 3: 'cialo-pelne' },
};

const POZIOM_SKALI_TYPE = 'poziom_skali';

const RATE_LIMIT_DELAY_MS = 550;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
// metafieldsSet dopuszcza maks. 25 metapól na jedno wywołanie (limit
// udokumentowany przez Shopify). Każdy produkt może teraz nieść do 6 pól
// (skale, typ_wina, tekst_seo, przechowywanie, wartosci_odzywcze_i_alergeny,
// dominujace_nuty) — przy BATCH_SIZE liczonym w PRODUKTACH, nie polach,
// 5 produktów × 6 pól = 30 przekroczyłoby limit. 4 × 6 = 24 mieści się z
// zapasem nawet gdyby doszło kolejne pole.
const BATCH_SIZE = 4;

function parseArgs(argv) {
  const args = { dryRun: true, file: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--file') {
      args.file = argv[i + 1];
      i++;
    } else if (arg.startsWith('--file=')) {
      args.file = arg.slice('--file='.length);
    }
  }
  return args;
}

function readRows(filePath) {
  const workbook = xlsx.readFile(filePath);
  if (!workbook.SheetNames.includes(SHEET_NAME)) {
    throw new Error(`Brak arkusza "${SHEET_NAME}" w pliku. Dostępne arkusze: ${workbook.SheetNames.join(', ')}`);
  }
  const sheet = workbook.Sheets[SHEET_NAME];
  return xlsx.utils.sheet_to_json(sheet, { defval: '' });
}

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

/**
 * Konwersja płaskiego tekstu (linie rozdzielone \n) na rich_text_field.
 * Zapis SPŁASZCZA formatowanie celowo — same akapity, bez nagłówków,
 * zgodnie z regułą "Tekst SEO" w specyfikacji.
 */
function buildRichTextFromFlatText(text) {
  const paragraphs = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    type: 'root',
    children: paragraphs.map((p) => ({ type: 'paragraph', children: [{ type: 'text', value: p }] })),
  };
}

/**
 * Parsuje jeden wiersz arkusza wg reguł Etapu 1.
 * @returns {{ status: 'skip', reason: string } | { status: 'error', reason: string, handle: string } | { status: 'data', handle: string, axisLevels: Array<{axisHandle:string, level:number, column:string}>, typWina: string|null, tekstSeoRaw: string|null, przechowywanie: string|null, wartosciOdzywcze: string|null, dominujaceNuty: string|null }}
 */
function buildRow(row) {
  const handle = String(row[COL_HANDLE] ?? '').trim();
  const rowType = String(row[COL_ROW_TYPE] ?? '').trim();

  if (rowType.toUpperCase() === ROW_TYPE_WZOR) {
    return { status: 'skip', reason: `wiersz WZÓR (${handle || 'bez handle'})` };
  }
  if (!handle) {
    return { status: 'skip', reason: 'brak Handle w wierszu' };
  }

  const wygladFilled = [];
  for (const [column, axisHandle] of Object.entries(WYGLAD_COLUMN_TO_AXIS)) {
    if (!isBlank(row[column])) wygladFilled.push({ column, axisHandle, raw: row[column] });
  }
  if (wygladFilled.length > 1) {
    return {
      status: 'error',
      handle,
      reason: `wypełnione ${wygladFilled.length} kolumny Wygląd jednocześnie (${wygladFilled.map((w) => w.column).join(', ')}) — powinna być dokładnie jedna albo żadna`,
    };
  }

  const axisLevels = [];
  if (wygladFilled.length === 1) {
    const { column, axisHandle, raw } = wygladFilled[0];
    axisLevels.push({ axisHandle, level: Number(raw), column });
  }
  for (const [column, axisHandle] of Object.entries(OTHER_AXIS_COLUMNS)) {
    if (!isBlank(row[column])) axisLevels.push({ axisHandle, level: Number(row[column]), column });
  }

  const typWinaRaw = String(row[COL_TYP_WINA] ?? '').trim();
  const tekstSeoRaw = String(row[COL_TEKST_SEO] ?? '').trim();
  const przechowywanieRaw = String(row[COL_PRZECHOWYWANIE] ?? '').trim();
  const wartosciOdzywczeRaw = String(row[COL_WARTOSCI_ODZYWCZE] ?? '').trim();
  const dominujaceNutyRaw = String(row[COL_DOMINUJACE_NUTY] ?? '').trim();

  const typWina = typWinaRaw !== '' ? typWinaRaw : null;
  const tekstSeoInput = tekstSeoRaw !== '' ? tekstSeoRaw : null;
  const przechowywanie = przechowywanieRaw !== '' ? przechowywanieRaw : null;
  const wartosciOdzywcze = wartosciOdzywczeRaw !== '' ? wartosciOdzywczeRaw : null;
  const dominujaceNuty = dominujaceNutyRaw !== '' ? dominujaceNutyRaw : null;

  if (
    axisLevels.length === 0 &&
    typWina === null &&
    tekstSeoInput === null &&
    przechowywanie === null &&
    wartosciOdzywcze === null &&
    dominujaceNuty === null
  ) {
    return { status: 'skip', reason: `${handle}: brak danych w żadnej z importowanych kolumn — bez pustego update'u` };
  }

  return {
    handle,
    axisLevels,
    typWina,
    tekstSeoRaw: tekstSeoInput,
    przechowywanie,
    wartosciOdzywcze,
    dominujaceNuty,
    status: 'data',
  };
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

// Wariant dla scripts/lib/resolve-metaobject-handle.mjs — ten helper sam
// czyta json.errors/json.data z odpowiedzi (patrz jego kod + użycie w
// import-sensoryka.mjs, które przekazuje surowy shopifyGraphQL, nie
// odpakowany na .data). graphqlWithRetry niżej odpakowuje do .data i rzuca
// na błędach — inny kształt, nie da się przekazać bezpośrednio.
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
  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query, variables });
    if (isThrottled(json)) {
      if (attempt > MAX_RETRIES) throw new Error('Przekroczono limit prób po THROTTLED');
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
    return json.data;
  }
}

const PRODUCT_QUERY = /* GraphQL */ `
  query MmwWineProduct($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      title
      skale: metafield(namespace: "custom", key: "skale") {
        value
      }
      typWina: metafield(namespace: "custom", key: "typ_wina") {
        value
      }
      tekstSeo: metafield(namespace: "custom", key: "tekst_seo") {
        value
      }
      przechowywanie: metafield(namespace: "custom", key: "przechowywanie") {
        value
      }
      wartosciOdzywcze: metafield(namespace: "custom", key: "wartosci_odzywcze_i_alergeny") {
        value
      }
      dominujaceNuty: metafield(namespace: "custom", key: "dominujace_nuty") {
        value
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation MmwMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('Brak pliku wejściowego. Użycie: node import-wina.mjs --file <ścieżka.xlsx> [--commit]');
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
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w .env. Sprawdź plik scripts/.env.');
    process.exit(1);
  }

  const graphql = graphqlRawWithRetry;

  console.log(args.dryRun ? 'Tryb: DRY-RUN (bez zapisu do Shopify)' : 'Tryb: COMMIT (realny zapis do Shopify)');
  console.log('');

  const rows = readRows(filePath);
  console.log(`Wczytano ${rows.length} wierszy z arkusza "${SHEET_NAME}".`);

  const skipped = [];
  const dataErrors = [];
  const toResolve = [];

  for (const row of rows) {
    const result = buildRow(row);
    if (result.status === 'skip') {
      skipped.push(result.reason);
    } else if (result.status === 'error') {
      dataErrors.push(`${result.handle}: ${result.reason}`);
    } else {
      toResolve.push(result);
    }
  }

  console.log(`Pominięte wiersze (WZÓR / brak danych): ${skipped.length}`);
  console.log(`Do przetworzenia: ${toResolve.length}`);
  console.log('');

  // --- Rozwiązanie produktów: handle -> {id, title, obecne wartości 3 metapól} ---
  const notFound = [];
  const resolved = [];

  for (const item of toResolve) {
    const data = await graphqlWithRetry({ store, token, query: PRODUCT_QUERY, variables: { handle: item.handle } });
    const product = data.productByHandle;
    if (!product) {
      notFound.push(item.handle);
      continue;
    }
    resolved.push({ ...item, product });
    await sleep(150);
  }

  if (notFound.length > 0) {
    console.log(`--- Produkty nieznalezione w sklepie (${notFound.length}) — pominięte, nie próbowano dopasować po podobieństwie ---`);
    for (const h of notFound) console.log(`  - ${h}`);
    console.log('');
  }

  // --- Rozwiązanie GID-ów poziomów sensorycznych ---
  const planned = [];
  for (const item of resolved) {
    const skaleGids = [];
    let axisError = null;
    for (const { axisHandle, level, column } of item.axisLevels) {
      const levelHandle = LEVEL_HANDLES[axisHandle]?.[level];
      if (!levelHandle) {
        axisError = `${item.handle}: brak zdefiniowanego poziomu ${level} dla osi ${axisHandle} (kolumna "${column}")`;
        break;
      }
      const gid = await resolveMetaobjectGid({ store, token, graphql, type: POZIOM_SKALI_TYPE, handle: levelHandle });
      if (!gid) {
        axisError = `${item.handle}: metaobiekt poziom_skali:${levelHandle} nie istnieje w sklepie`;
        break;
      }
      skaleGids.push(gid);
    }
    if (axisError) {
      dataErrors.push(axisError);
      continue;
    }
    planned.push({ ...item, skaleGids });
  }

  if (dataErrors.length > 0) {
    console.log(`--- Błędy danych (${dataErrors.length}) — te wiersze NIE wchodzą do paczki ---`);
    for (const e of dataErrors) console.log(`  - ${e}`);
    console.log('');
  }

  // --- Budowa planu zapisu per produkt, z regułą "SEO tylko gdy puste" ---
  let seoWillWrite = 0;
  let seoSkippedNonEmpty = 0;

  console.log('--- Plan (dry-run) ---');
  for (const item of planned) {
    const { product, axisLevels, typWina, tekstSeoRaw, skaleGids, przechowywanie, wartosciOdzywcze, dominujaceNuty } = item;
    console.log(`\n${item.handle} (${product.title})`);

    if (axisLevels.length > 0) {
      const currentSkale = product.skale?.value ?? null;
      const action = currentSkale ? 'UPDATE (nadpisanie istniejącej wartości)' : 'CREATE';
      console.log(`  custom.skale: teraz = ${currentSkale ? currentSkale : '(puste)'}`);
      console.log(`  custom.skale: będzie = ${JSON.stringify(skaleGids)} [${action}]`);
    } else {
      console.log('  custom.skale: bez zmian (brak danych sensorycznych w arkuszu dla tego wiersza)');
    }

    if (typWina !== null) {
      const currentTypWina = product.typWina?.value ?? null;
      const action = currentTypWina ? 'UPDATE (nadpisanie istniejącej wartości)' : 'CREATE';
      console.log(`  custom.typ_wina: teraz = "${currentTypWina ?? ''}" -> będzie = "${typWina}" [${action}]`);
    } else {
      console.log('  custom.typ_wina: bez zmian (puste w arkuszu)');
    }

    if (tekstSeoRaw !== null) {
      const currentSeo = product.tekstSeo?.value ?? null;
      if (!currentSeo) {
        console.log(`  custom.tekst_seo: CREATE — w sklepie puste, wchodzi tekst z arkusza (${tekstSeoRaw.length} znaków źródłowych)`);
        seoWillWrite++;
      } else if (isStaleSeoPlaceholder(currentSeo)) {
        console.log(`  custom.tekst_seo: NADPISANIE placeholdera — w sklepie jest rozpoznany nieprawidłowy tekst WZÓR (521 znaków JSON), wchodzi tekst z arkusza (${tekstSeoRaw.length} znaków źródłowych)`);
        seoWillWrite++;
      } else {
        console.log(`  custom.tekst_seo: POMINIĘTE — w sklepie jest inna, niepusta treść (${currentSeo.length} znaków JSON), nie nadpisuję`);
        seoSkippedNonEmpty++;
      }
    } else {
      console.log('  custom.tekst_seo: bez zmian (puste w arkuszu)');
    }

    if (przechowywanie !== null) {
      const current = product.przechowywanie?.value ?? null;
      const action = current ? 'UPDATE (nadpisanie istniejącej wartości)' : 'CREATE';
      console.log(`  custom.przechowywanie: [${action}] (${przechowywanie.length} znaków źródłowych)`);
    } else {
      console.log('  custom.przechowywanie: bez zmian (puste w arkuszu)');
    }

    if (wartosciOdzywcze !== null) {
      const current = product.wartosciOdzywcze?.value ?? null;
      const action = current ? 'UPDATE (nadpisanie istniejącej wartości)' : 'CREATE';
      console.log(`  custom.wartosci_odzywcze_i_alergeny: [${action}] (${wartosciOdzywcze.length} znaków źródłowych)`);
    } else {
      console.log('  custom.wartosci_odzywcze_i_alergeny: bez zmian (puste w arkuszu)');
    }

    if (dominujaceNuty !== null) {
      const current = product.dominujaceNuty?.value ?? null;
      const action = current ? 'UPDATE (nadpisanie istniejącej wartości)' : 'CREATE';
      console.log(`  custom.dominujace_nuty: [${action}] (${dominujaceNuty.length} znaków źródłowych)`);
    } else {
      console.log('  custom.dominujace_nuty: bez zmian (puste w arkuszu)');
    }
  }

  console.log('');
  console.log('--- Tekst SEO — podsumowanie ---');
  console.log(`Wejdzie (puste lub rozpoznany placeholder WZÓR): ${seoWillWrite}`);
  console.log(`Pominięte (w sklepie jest inna, niepusta treść): ${seoSkippedNonEmpty}`);

  console.log('');
  console.log('--- Podsumowanie ---');
  console.log(`Produktów w paczce: ${planned.length}`);
  console.log(`Pominiętych wierszy (WZÓR / brak danych): ${skipped.length}`);
  console.log(`Nieznalezionych produktów: ${notFound.length}`);
  console.log(`Błędów danych: ${dataErrors.length}`);

  if (args.dryRun) {
    console.log('');
    console.log('Dry-run zakończony. Aby zapisać, uruchom z flagą --commit.');
    return;
  }

  // --- Etap 3: zapis w paczkach po max BATCH_SIZE produktów ---
  console.log('');
  console.log(`Zapisuję w paczkach po max ${BATCH_SIZE} produktów...`);

  const toWrite = planned
    .map((item) => {
      const metafields = [];
      if (item.axisLevels.length > 0) {
        metafields.push({
          ownerId: item.product.id,
          namespace: 'custom',
          key: 'skale',
          type: 'list.metaobject_reference',
          value: JSON.stringify(item.skaleGids),
        });
      }
      if (item.typWina !== null) {
        metafields.push({
          ownerId: item.product.id,
          namespace: 'custom',
          key: 'typ_wina',
          type: 'single_line_text_field',
          value: item.typWina,
        });
      }
      const currentSeo = item.product.tekstSeo?.value ?? null;
      if (item.tekstSeoRaw !== null && (!currentSeo || isStaleSeoPlaceholder(currentSeo))) {
        metafields.push({
          ownerId: item.product.id,
          namespace: 'custom',
          key: 'tekst_seo',
          type: 'rich_text_field',
          value: JSON.stringify(buildRichTextFromFlatText(item.tekstSeoRaw)),
        });
      }
      if (item.przechowywanie !== null) {
        metafields.push({
          ownerId: item.product.id,
          namespace: 'custom',
          key: 'przechowywanie',
          type: 'multi_line_text_field',
          value: item.przechowywanie,
        });
      }
      if (item.wartosciOdzywcze !== null) {
        metafields.push({
          ownerId: item.product.id,
          namespace: 'custom',
          key: 'wartosci_odzywcze_i_alergeny',
          type: 'rich_text_field',
          value: JSON.stringify(buildRichTextFromFlatText(item.wartosciOdzywcze)),
        });
      }
      if (item.dominujaceNuty !== null) {
        metafields.push({
          ownerId: item.product.id,
          namespace: 'custom',
          key: 'dominujace_nuty',
          type: 'multi_line_text_field',
          value: item.dominujaceNuty,
        });
      }
      return { handle: item.handle, metafields };
    })
    .filter((x) => x.metafields.length > 0);

  const batches = [];
  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    batches.push(toWrite.slice(i, i + BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const handles = batch.map((x) => x.handle);
    console.log(`\nPaczka ${b + 1}/${batches.length}: ${handles.join(', ')}`);

    const metafields = batch.flatMap((x) => x.metafields);

    let attempt = 0;
    let json;
    while (true) {
      attempt++;
      json = await shopifyGraphQL({ store, token, query: METAFIELDS_SET_MUTATION, variables: { metafields } });
      if (isThrottled(json)) {
        if (attempt > MAX_RETRIES) throw new Error('Przekroczono limit prób po THROTTLED');
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    if (json.errors) {
      console.log(`  BŁĄD GraphQL: ${JSON.stringify(json.errors)}`);
      console.log('  Przerywam — kolejne paczki NIE są przetwarzane.');
      process.exitCode = 1;
      return;
    }

    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.log(`  BŁĄD: ${JSON.stringify(userErrors, null, 2)}`);
      console.log('  Przerywam — kolejne paczki NIE są przetwarzane.');
      process.exitCode = 1;
      return;
    }

    console.log(`  OK — zapisano ${json.data.metafieldsSet.metafields.length} pól dla ${handles.length} produktów.`);

    if (b < batches.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log('');
  console.log(`Gotowe. Zapisano ${batches.length} paczek, ${toWrite.length} produktów.`);
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
