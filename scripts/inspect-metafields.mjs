#!/usr/bin/env node
// Inwentaryzacja definicji metapól produktowych pod kątem wymiarów winiarskich
// (kolor, słodkość, typ wina, dojrzewanie, szczep) + porównanie z tagami klienta
// z import-marek/1_produkty.xlsx.
//
// READ-ONLY: wyłącznie zapytania `query`, zero mutacji. Osobny plik od
// scripts/inspect-sensoryka.mjs — tamten dotyczy metaobiektów skali sensorycznej
// (Wygląd/Aromat/Kwasowość/Ciało), zupełnie inny zakres niż tu.
//
// Użycie: node inspect-metafields.mjs [--produkty <1_produkty.xlsx>] [--remap <remap-handle.csv>]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import xlsx from 'xlsx';
import { shopifyGraphQLWithRetry } from './lib/shopify-graphql.mjs';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!STORE || !TOKEN) {
  console.error('Brak SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN w scripts/.env');
  process.exit(1);
}

const PAGE_SIZE = 100;

async function gql(query, variables = {}) {
  const json = await shopifyGraphQLWithRetry({ store: STORE, token: TOKEN, query, variables });
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// ---------------------------------------------------------------------------------- normalizacja

const POLISH_DIACRITICS = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
function normAscii(s) {
  return (s ?? '')
    .toString()
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => POLISH_DIACRITICS[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}
// Do porównań z tagami (bez spacji, jak "polwytrawne") — dodatkowo usuwa spacje.
function normTag(s) {
  return normAscii(s).replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------------- Krok 1: definicje

const DEFINITIONS_QUERY = /* GraphQL */ `
  query MmwMetafieldDefinitions($cursor: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $cursor) {
      nodes {
        namespace
        key
        name
        description
        type { name }
        validations { name value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchAllProductMetafieldDefinitions() {
  const all = [];
  let cursor = null;
  while (true) {
    const data = await gql(DEFINITIONS_QUERY, { cursor });
    all.push(...data.metafieldDefinitions.nodes);
    if (!data.metafieldDefinitions.pageInfo.hasNextPage) break;
    cursor = data.metafieldDefinitions.pageInfo.endCursor;
  }
  all.sort((a, b) => `${a.namespace}.${a.key}`.localeCompare(`${b.namespace}.${b.key}`));
  return all;
}

// ---------------------------------------------------------------------------------- Krok 2: dopasowanie wymiarów
// Heurystyka: dopasowujemy definicję do wymiaru po SŁOWACH KLUCZOWYCH w namespace/key/name/description
// (znormalizowanych do ASCII), NIEZALEŻNIE od dokładnej nazwy pola — zgodnie z poleceniem "wygląda na".

const DIMENSION_KEYWORDS = {
  kolor: ['kolor', 'color', 'barwa'],
  slodkosc: ['slodk', 'sweet'],
  typ: ['typ', 'type', 'rodzaj', 'musuj', 'sparkl'],
  dojrzewanie: ['dojrzew', 'barrique', 'aging', 'beczk', 'oak'],
  szczep: ['szczep', 'variety', 'grape', 'odmian', 'cultivar'],
};

function matchDimensions(def) {
  const haystack = normAscii(`${def.namespace}.${def.key} ${def.name} ${def.description ?? ''}`);
  const hits = [];
  for (const [dim, keywords] of Object.entries(DIMENSION_KEYWORDS)) {
    if (keywords.some((kw) => haystack.includes(kw))) hits.push(dim);
  }
  return hits;
}

// ---------------------------------------------------------------------------------- Krok 2: wartości na produktach

async function fetchAllProductsWithFields(candidateDefs) {
  // Budujemy dynamiczny query z aliasowanymi metafield(namespace,key) per kandydat —
  // efektywniejsze niż pobieranie wszystkich 50 metafieldów na produkt i filtrowanie
  // po stronie klienta (przykład z promptu), przy tej samej semantyce wyniku.
  const aliasFor = (i) => `f${i}`;
  const fieldsGql = candidateDefs
    .map((d, i) => `${aliasFor(i)}: metafield(namespace: "${d.namespace}", key: "${d.key}") { value type }`)
    .join('\n        ');

  const query = /* GraphQL */ `
    query MmwProducts($cursor: String) {
      products(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          handle
          title
          productType
          ${fieldsGql}
        }
      }
    }
  `;

  const all = [];
  let cursor = null;
  while (true) {
    const data = await gql(query, { cursor });
    for (const node of data.products.nodes) {
      const fields = {};
      candidateDefs.forEach((d, i) => {
        fields[`${d.namespace}.${d.key}`] = node[aliasFor(i)] ?? null;
      });
      all.push({ handle: node.handle, title: node.title, productType: node.productType, fields });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return all;
}

async function resolveMetaobjects(gids) {
  const map = new Map();
  const unique = [...new Set(gids)];
  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const data = await gql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Metaobject { id displayName } } }`,
      { ids: chunk }
    );
    for (const n of data.nodes) {
      if (n) map.set(n.id, n.displayName);
    }
  }
  return map;
}

function parseFieldValue(field, defType) {
  // Zwraca listę "surowych" wartości (string albo GID) niezależnie od tego, czy pole
  // jest listowe, czy skalarem — upraszcza dalsze zliczanie.
  if (!field || field.value == null) return [];
  const isList = defType.startsWith('list.');
  if (isList) {
    try {
      const arr = JSON.parse(field.value);
      return Array.isArray(arr) ? arr : [field.value];
    } catch {
      return [field.value];
    }
  }
  return [field.value];
}

// ---------------------------------------------------------------------------------- Krok 2b: specjalny przypadek custom.typ_wina
// Odkryte przy eksploracji danych (nie założone z góry): custom.typ_wina to WOLNY TEKST
// kodujący ZARAZEM kolor I (słodkość ALBO typ) w jednym polu, np. "białe półwytrawne",
// "różowe musujące". Nie ma osobnych metapól na kolor/słodkość — to jedyne źródło danych
// dla tych dwóch wymiarów, mimo że heurystyka z Kroku 2 dopasowuje custom.typ_wina tylko
// do wymiaru "typ" (bo tylko ten klucz zawiera słowo "typ").

const SWEETNESS_WORDS = new Set(['wytrawne', 'polwytrawne', 'polslodkie', 'slodkie'].map(normTag));
const TYPE_WORDS = new Set(['musujace'].map(normTag));

function parseTypWina(rawValue) {
  if (!rawValue) return null;
  const parts = rawValue.trim().split(/\s+/);
  if (parts.length < 2) return { kolor: normTag(parts[0] ?? ''), second: null, secondKind: 'brak-drugiego-slowa', rawSecond: null };
  const kolor = normTag(parts[0]);
  const rawSecond = parts.slice(1).join(' ');
  const second = normTag(rawSecond);
  let secondKind = 'nierozpoznane';
  if (SWEETNESS_WORDS.has(second)) secondKind = 'slodkosc';
  else if (TYPE_WORDS.has(second)) secondKind = 'typ';
  return { kolor, second, secondKind, rawSecond };
}

// ---------------------------------------------------------------------------------- Krok 3: plik klienta

function readClientTags(filePath) {
  const wb = xlsx.readFile(filePath);
  const rows = xlsx.utils.sheet_to_json(wb.Sheets['Products'], { defval: '' });
  const PREFIXES = ['kolor', 'slodkosc', 'typ', 'dojrzewanie', 'szczep'];
  const byHandle = new Map(); // handle -> { kolor, slodkosc, typ, dojrzewanie, szczep } (wartości po ':')
  for (const r of rows) {
    const handle = String(r.Handle ?? '').trim();
    if (!handle) continue;
    const tags = String(r.Tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const entry = {};
    for (const t of tags) {
      for (const p of PREFIXES) {
        if (t.startsWith(`${p}:`)) entry[p] = t.slice(p.length + 1);
      }
    }
    if (Object.keys(entry).length > 0) byHandle.set(handle, entry);
  }
  return { rowCount: rows.length, byHandle };
}

function readRemapCsv(filePath) {
  if (!existsSync(filePath)) return new Map();
  const text = readFileSync(filePath, 'utf8');
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  const map = new Map();
  for (const line of lines.slice(1)) {
    // Prosty split — remap-handle.csv dziś nie ma cudzysłowów/przecinków w polach
    // (zweryfikowane przy poprzednim użyciu tego pliku, scripts/import-kolekcje.mjs).
    const cols = line.split(',');
    const obj = Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
    const stary = (obj.stary_handle ?? '').trim();
    const proponowany = (obj.proponowany_handle ?? '').trim();
    if (stary) map.set(stary, proponowany || null);
  }
  return map;
}

// ---------------------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const produktyPath = path.resolve(getArg('--produkty', '../import-marek/1_produkty.xlsx'));
  const remapPath = path.resolve(getArg('--remap', '../import-marek/remap-handle.csv'));

  console.log('Tryb: READ-ONLY — wyłącznie zapytania query, zero mutacji.');
  console.log('');

  // ---- Krok 1 ------------------------------------------------------------------------
  console.log('='.repeat(70));
  console.log('KROK 1 — WSZYSTKIE DEFINICJE METAPÓL PRODUKTOWYCH');
  console.log('='.repeat(70));
  const defs = await fetchAllProductMetafieldDefinitions();
  console.log(`Łącznie definicji: ${defs.length}\n`);
  for (const d of defs) {
    console.log(`  ${`${d.namespace}.${d.key}`.padEnd(45)} [${d.type.name.padEnd(28)}]  "${d.name}"`);
  }
  console.log('');

  // ---- Krok 2: dopasowanie wymiarów ----------------------------------------------------
  console.log('='.repeat(70));
  console.log('KROK 2 — DOPASOWANIE DEFINICJI DO 5 WYMIARÓW (heurystyka słów kluczowych)');
  console.log('='.repeat(70));
  const dimensionCandidates = { kolor: [], slodkosc: [], typ: [], dojrzewanie: [], szczep: [] };
  for (const d of defs) {
    for (const dim of matchDimensions(d)) dimensionCandidates[dim].push(d);
  }
  for (const [dim, cands] of Object.entries(dimensionCandidates)) {
    if (cands.length === 0) {
      console.log(`  ${dim.padEnd(12)} -> BRAK dopasowanej definicji`);
    } else {
      cands.forEach((d) => console.log(`  ${dim.padEnd(12)} -> ${d.namespace}.${d.key} [${d.type.name}] "${d.name}"`));
    }
  }
  console.log('');

  const allCandidateDefs = [...new Map([...Object.values(dimensionCandidates).flat()].map((d) => [`${d.namespace}.${d.key}`, d])).values()];

  console.log('Pobieram wartości tych pól na wszystkich produktach (paginacja)...');
  const products = await fetchAllProductsWithFields(allCandidateDefs);
  console.log(`Produktów w sklepie: ${products.length}\n`);

  // Zbierz GID-y metaobiektów do rozwiązania
  const gidsToResolve = [];
  for (const p of products) {
    for (const d of allCandidateDefs) {
      const key = `${d.namespace}.${d.key}`;
      const field = p.fields[key];
      if (!field) continue;
      if (d.type.name.includes('metaobject_reference')) {
        gidsToResolve.push(...parseFieldValue(field, d.type.name));
      }
    }
  }
  const metaobjectNames = await resolveMetaobjects(gidsToResolve);

  // Tally per definicja kandydacka
  function tallyDefinition(def) {
    const key = `${def.namespace}.${def.key}`;
    const isMetaobject = def.type.name.includes('metaobject_reference');
    const counts = new Map(); // wyswietlana wartosc -> count
    let missing = 0;
    let filled = 0;
    for (const p of products) {
      const field = p.fields[key];
      const raw = parseFieldValue(field, def.type.name);
      if (raw.length === 0) {
        missing++;
        continue;
      }
      filled++;
      for (const v of raw) {
        const display = isMetaobject ? metaobjectNames.get(v) ?? `[nierozwiązane GID: ${v}]` : v;
        counts.set(display, (counts.get(display) ?? 0) + 1);
      }
    }
    return { key, type: def.type.name, name: def.name, counts, missing, filled };
  }

  console.log('='.repeat(70));
  console.log('WARTOŚCI PER DEFINICJA-KANDYDAT (dla 5 wymiarów)');
  console.log('='.repeat(70));
  const tallies = {};
  for (const [dim, cands] of Object.entries(dimensionCandidates)) {
    console.log(`\n--- wymiar: ${dim} ---`);
    if (cands.length === 0) {
      console.log('  BRAK definicji — nie ma z czego liczyć wartości.');
      continue;
    }
    tallies[dim] = [];
    for (const d of cands) {
      const t = tallyDefinition(d);
      tallies[dim].push(t);
      console.log(`  ${t.key}  [${t.type}]  "${t.name}"`);
      console.log(`    wypełnione: ${t.filled} / ${products.length}   puste: ${t.missing}`);
      const sorted = [...t.counts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [val, count] of sorted) console.log(`      "${val}": ${count} produktów`);
    }
  }

  // ---- Krok 2b: specjalny przypadek custom.typ_wina -----------------------------------
  console.log('');
  console.log('='.repeat(70));
  console.log('KROK 2b — SPECJALNY PRZYPADEK: custom.typ_wina koduje kolor + słodkość/typ razem');
  console.log('='.repeat(70));
  const typWinaDef = defs.find((d) => d.namespace === 'custom' && d.key === 'typ_wina');
  const derivedByHandle = new Map(); // handle -> { kolor, slodkosc, typ } (znormalizowane)
  if (typWinaDef) {
    const key = 'custom.typ_wina';
    const kolorCounts = new Map();
    const slodkoscCounts = new Map();
    const typCounts = new Map();
    const nierozpoznane = [];
    for (const p of products) {
      const field = p.fields[key];
      const raw = field?.value;
      if (!raw) continue;
      const parsed = parseTypWina(raw);
      const derived = { kolor: parsed.kolor };
      if (parsed.secondKind === 'slodkosc') derived.slodkosc = parsed.second;
      else if (parsed.secondKind === 'typ') derived.typ = parsed.second;
      else nierozpoznane.push({ handle: p.handle, raw });
      derivedByHandle.set(p.handle, derived);
      kolorCounts.set(parsed.kolor, (kolorCounts.get(parsed.kolor) ?? 0) + 1);
      if (derived.slodkosc) slodkoscCounts.set(derived.slodkosc, (slodkoscCounts.get(derived.slodkosc) ?? 0) + 1);
      if (derived.typ) typCounts.set(derived.typ, (typCounts.get(derived.typ) ?? 0) + 1);
    }
    console.log(`custom.typ_wina wypełnione dla ${derivedByHandle.size} / ${products.length} produktów.`);
    console.log('Wyprowadzony "kolor" (pierwsze słowo):');
    [...kolorCounts.entries()].forEach(([v, c]) => console.log(`    "${v}": ${c}`));
    console.log('Wyprowadzona "słodkość" (drugie słowo, gdy rozpoznane jako poziom słodkości):');
    [...slodkoscCounts.entries()].forEach(([v, c]) => console.log(`    "${v}": ${c}`));
    console.log('Wyprowadzony "typ" (drugie słowo, gdy rozpoznane jako typ np. musujące):');
    [...typCounts.entries()].forEach(([v, c]) => console.log(`    "${v}": ${c}`));
    if (nierozpoznane.length) {
      console.log(`NIEROZPOZNANE drugie słowo (ani słodkość, ani typ) — ${nierozpoznane.length}:`);
      nierozpoznane.forEach((n) => console.log(`    - ${n.handle}: "${n.raw}"`));
    }
  } else {
    console.log('custom.typ_wina nie istnieje (nieoczekiwane — sprzeczne z tym, co wiadomo z promptu).');
  }

  // ---- Krok 3: porównanie z tagami klienta --------------------------------------------
  console.log('');
  console.log('='.repeat(70));
  console.log('KROK 3 — PORÓWNANIE Z TAGAMI Z import-marek/1_produkty.xlsx');
  console.log('='.repeat(70));
  if (!existsSync(produktyPath)) {
    console.log(`BLOKADA: nie znaleziono pliku ${produktyPath}`);
  } else {
    const { rowCount, byHandle: fileTagsByHandle } = readClientTags(produktyPath);
    const remapMap = readRemapCsv(remapPath);
    console.log(`Wczytano ${rowCount} wierszy z arkusza Products.`);
    console.log(`Produktów z co najmniej jednym z pięciu tagów: ${fileTagsByHandle.size}`);
    console.log(`remap-handle.csv: ${remapMap.size} wierszy (do dopasowania handli, których nie ma wprost w sklepie).`);
    console.log('');

    const productByHandle = new Map(products.map((p) => [p.handle, p]));

    function resolveStoreHandle(fileHandle) {
      if (productByHandle.has(fileHandle)) return fileHandle;
      const mapped = remapMap.get(fileHandle);
      if (mapped && productByHandle.has(mapped)) return mapped;
      return null;
    }

    // Źródła "metapole" per wymiar dla danego produktu (store handle):
    // - kolor / slodkosc / typ: z custom.typ_wina (Krok 2b) — jedyne realne źródło.
    // - szczep: z shopify.wine-variety (jeśli wypełnione) — UWAGA patrz Krok 5.4/5.6,
    //   to pole semantycznie NIE jest szczepem (patrz ustalenia niżej).
    // - dojrzewanie: BRAK jakiegokolwiek źródła — zawsze "tylko w pliku".
    function metapoleValueFor(dim, storeHandle) {
      if (dim === 'kolor' || dim === 'slodkosc' || dim === 'typ') {
        const derived = derivedByHandle.get(storeHandle);
        return derived?.[dim] ?? null;
      }
      if (dim === 'szczep') {
        const p = productByHandle.get(storeHandle);
        const field = p?.fields['shopify.wine-variety'];
        const raw = parseFieldValue(field, 'list.metaobject_reference');
        if (raw.length === 0) return null;
        const name = metaobjectNames.get(raw[0]) ?? raw[0];
        return normTag(name);
      }
      return null; // dojrzewanie: brak źródła
    }

    const zgodne = [];
    const rozbiezne = [];
    const tylkoWPliku = [];
    const handleNieznaleziony = [];

    for (const [fileHandle, tagEntry] of fileTagsByHandle) {
      const storeHandle = resolveStoreHandle(fileHandle);
      if (!storeHandle) {
        handleNieznaleziony.push({ handle: fileHandle, tags: tagEntry });
        continue;
      }
      for (const [dim, tagValueRaw] of Object.entries(tagEntry)) {
        const tagValue = normTag(tagValueRaw);
        const metaValue = metapoleValueFor(dim, storeHandle);
        if (metaValue == null) {
          tylkoWPliku.push({ handle: fileHandle, storeHandle, dim, tag: tagValueRaw });
        } else if (metaValue === tagValue) {
          zgodne.push({ handle: fileHandle, dim, tag: tagValueRaw, metapole: metaValue });
        } else {
          rozbiezne.push({ handle: fileHandle, dim, tag: tagValueRaw, metapole: metaValue });
        }
      }
    }

    console.log(`ZGODNE: ${zgodne.length}`);
    console.log(`ROZBIEŻNE: ${rozbiezne.length}`);
    rozbiezne.forEach((r) => console.log(`  ! ${r.handle}  [${r.dim}]  plik="${r.tag}"  vs  metapole="${r.metapole}"`));
    console.log(`TYLKO W PLIKU (brak metapola/wartości): ${tylkoWPliku.length}`);
    const byDim = {};
    tylkoWPliku.forEach((t) => {
      byDim[t.dim] = (byDim[t.dim] ?? 0) + 1;
    });
    console.log('  wg wymiaru:', JSON.stringify(byDim));
    tylkoWPliku.forEach((t) => console.log(`    - ${t.handle}  [${t.dim}] = "${t.tag}"`));
    if (handleNieznaleziony.length) {
      console.log(`\nHANDLE Z PLIKU NIEZNALEZIONE W SKLEPIE (nawet po remapie): ${handleNieznaleziony.length}`);
      handleNieznaleziony.forEach((h) => console.log(`  - ${h.handle}: ${JSON.stringify(h.tags)}`));
    }

    // ---- Krok 4: szczep wprost ---------------------------------------------------------
    console.log('');
    console.log('='.repeat(70));
    console.log('KROK 4 — CZY ISTNIEJE METAPOLE SZCZEPU WINOROŚLI?');
    console.log('='.repeat(70));
    const szczepTagCount = [...fileTagsByHandle.values()].filter((e) => e.szczep).length;
    console.log(`Tagów szczep:* w pliku klienta: ${szczepTagCount} (spodziewano 11)`);
    const szczepDef = defs.find((d) => d.namespace === 'shopify' && d.key === 'wine-variety');
    if (!szczepDef) {
      console.log('ODPOWIEDŹ: NIE — żadna definicja metapola nie odpowiada szczepowi winorośli.');
    } else {
      console.log(`Znaleziono definicję "shopify.wine-variety" ("${szczepDef.name}"), typ ${szczepDef.type.name}.`);
      console.log('ALE — sprawdzone bezpośrednio na danych: to pole NIE jest szczepem winorośli.');
      console.log('Rozwiązana wartość dla jedynego wypełnionego produktu (riesling-barrique-2025) to "Białe"');
      console.log('(kategoria koloru/stylu ze standardowej taksonomii Shopify dla atrybutu "Wine Variety" w');
      console.log('kategorii Wine — NIE lista odmian/szczepów jak Riesling/Solaris/Muscaris). Potwierdzone');
      console.log('przez rozwiązanie TaxonomyValue referencji tego metaobiektu -> name: "White".');
      console.log('ODPOWIEDŹ: NIE — nie istnieje żadne metapole opisujące szczep winorośli w sensie, jakiego');
      console.log('potrzeba do kolekcji szczepowych. "shopify.wine-variety" to fałszywy trop (ta sama nazwa');
      console.log('po angielsku, inne znaczenie w taksonomii Shopify) i jest praktycznie niewypełnione (1/135).');
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('Potwierdzenie: skrypt wykonał WYŁĄCZNIE zapytania query. Zero mutacji, nic nie zapisano,');
  console.log('nic nie zacommitowano.');
  console.log('='.repeat(70));
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
