#!/usr/bin/env node
/**
 * audit-architektura.mjs
 *
 * READ-ONLY. Nic nie zapisuje do Shopify. Brak flagi --commit celowo.
 *
 * Porownuje pliki od Marka (1_produkty.xlsx, 2_kolekcje.xlsx, 3_menu_i_redirecty.xlsx)
 * ze stanem sklepu i wypisuje wszystkie rozjazdy, ktore wysadzilyby import.
 *
 * Uzycie:
 *   node scripts/audit-architektura.mjs --dir ./import-marek
 *   node scripts/audit-architektura.mjs --dir ./import-marek --json raport.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import dotenv from 'dotenv';

// Skrypt jest uruchamiany z katalogu głównego repo (--dir wskazuje import-marek/
// tam), ale .env leży w scripts/.env — jak we wszystkich innych skryptach w tym
// katalogu (patrz scripts/README.md). Gołe `dotenv.config()`/`dotenv/config`
// szuka .env względem process.cwd(), więc przy uruchomieniu z root repo by go
// nie znalazło. Ścieżka wyliczona z lokalizacji tego pliku, niezależnie od cwd.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2026-07'; // ujednolicone z pozostałymi skryptami (assign-pairings.mjs)

if (!STORE || !TOKEN) {
  console.error('Brak SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN w scripts/.env');
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const DIR = getArg('--dir', '.');
const JSON_OUT = getArg('--json', null);

// ---------------------------------------------------------------- GraphQL

async function gql(query, variables = {}) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error(JSON.stringify(json.errors, null, 2));
    const err = new Error('GraphQL error');
    err.graphqlErrors = json.errors;
    throw err;
  }
  return json.data;
}

async function fetchAllProducts() {
  const out = new Map();
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title status tags seo { title description } }
        }
      }`,
      { cursor }
    );
    for (const n of data.products.nodes) out.set(n.handle, n);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchAllCollections() {
  const out = new Map();
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        collections(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id handle title sortOrder
            productsCount { count }
            descriptionHtml
            seo { title description }
            ruleSet { appliedDisjunctively rules { column relation condition } }
          }
        }
      }`,
      { cursor }
    );
    for (const n of data.collections.nodes) out.set(n.handle, n);
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchShopName() {
  const data = await gql(`{ shop { name myshopifyDomain } }`);
  return data.shop;
}

async function fetchRedirects() {
  const out = new Map();
  let cursor = null;
  try {
    do {
      const data = await gql(
        `query($cursor: String) {
          urlRedirects(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id path target }
          }
        }`,
        { cursor }
      );
      for (const n of data.urlRedirects.nodes) out.set(n.path, n);
      cursor = data.urlRedirects.pageInfo.hasNextPage ? data.urlRedirects.pageInfo.endCursor : null;
    } while (cursor);
    return { available: true, map: out };
  } catch (err) {
    // Token custom app nie ma scope do odczytu redirectow (potwierdzone: nie da
    // sie go nadac w tym sklepie). Degradujemy TYLKO ten jeden zapytanie —
    // reszta audytu (produkty/kolekcje/menu) nie zalezy od tych danych.
    const accessDenied = err.graphqlErrors?.some((e) => e.extensions?.code === 'ACCESS_DENIED');
    if (accessDenied) {
      return { available: false, map: out };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- XLSX

function readSheet(file, sheet) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) {
    console.error(`Nie znaleziono pliku: ${p}`);
    process.exit(1);
  }
  const wb = XLSX.readFile(p);
  if (!wb.SheetNames.includes(sheet)) {
    console.error(`Plik ${file} nie ma arkusza "${sheet}". Arkusze: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
}

// ---------------------------------------------------------------- audit

const report = {
  shop: {},
  produkty: { brakujace: [], zmienioneTytulySeo: [], tagiDoDodania: [], ok: 0 },
  kolekcje: { doUtworzenia: [], istniejaceDoAktualizacji: [], konfliktTypu: [], ok: 0 },
  produktyWKolekcjach: { brakujaceHandle: [] },
  smartRuleCoverage: [],
  menu: { brakujaceKolekcje: [] },
  redirecty: { juzIstnieje: [], zasobBlokujacy: [] },
};

function norm(s) {
  return (s ?? '').toString().trim();
}

// ---------------------------------------------------------- baseline (Krok 4)
// Twardy check parsowania XLSX PRZED jakimkolwiek wywolaniem API — jesli
// pliki od klienta roznia sie od tych, na ktorych ustalono te liczby,
// zatrzymujemy sie zamiast liczyc rozjazdy na blednych danych.

const BASELINE = [
  ['Wiersze w 1_produkty.xlsx (arkusz Products)', 118],
  ['Unikalne handle w tym arkuszu', 118],
  ['Produkty z niepusta kolumna Tags', 36],
  ['Unikalne tagi', 18],
  ['Wiersze w Smart Collections', 11],
  ['Unikalne handle w Custom Collections', 26],
  ['Wiersze w Custom Collections lacznie', 221],
  ['Wiersze w arkuszu Menus', 37],
  ['Wiersze w arkuszu Redirects', 1],
];

function assertBaseline({ rowsP, rowsSC, rowsCC, rowsM, rowsR }) {
  const uniqueHandlesP = new Set(rowsP.map((r) => norm(r['Handle'])).filter(Boolean));
  const rowsWithTags = rowsP.filter((r) => norm(r['Tags']) !== '');
  const uniqueTags = new Set();
  rowsWithTags.forEach((r) =>
    norm(r['Tags']).split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => uniqueTags.add(t))
  );
  const uniqueHandlesCC = new Set(rowsCC.map((r) => norm(r['Handle'])).filter(Boolean));

  const actuals = [
    rowsP.length,
    uniqueHandlesP.size,
    rowsWithTags.length,
    uniqueTags.size,
    rowsSC.length,
    uniqueHandlesCC.size,
    rowsCC.length,
    rowsM.length,
    rowsR.length,
  ];

  const failed = BASELINE.filter(([, expected], i) => actuals[i] !== expected);

  console.log('Baseline parsowania XLSX (przed uderzeniem w API):');
  BASELINE.forEach(([label, expected], i) => {
    const actual = actuals[i];
    console.log(`  ${String(actual).padStart(4)} / ${String(expected).padStart(4)}  ${actual === expected ? 'OK' : '<-- NIEZGODNE'}  ${label}`);
  });
  console.log('');

  if (failed.length > 0) {
    console.error(
      `BASELINE NIE ZGADZA SIE (${failed.length}/${BASELINE.length} niezgodnosci) — pliki w ${DIR} sa inne niz te, na ktorych ustalono te liczby. Zatrzymuje sie PRZED zapytaniami do Shopify.`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------- remapowanie handli (Krok 3)
// Tylko PROPOZYCJA — nigdzie nie stosowana. Dla kazdego handle z pliku,
// ktorego nie ma w sklepie, probuje kolejno trzech metod i zapisuje, ktora
// zadzialala. Wynik idzie do import-marek/remap-handle.csv, do recznej
// akceptacji.

const POLISH_DIACRITICS = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

function normalizeTitle(s) {
  return (s ?? '')
    .toString()
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => POLISH_DIACRITICS[ch] ?? ch)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function csvEscape(v) {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

const ARCH_FILE = 'Majatek_Mala_Wies_-_architektura.xlsx';
const SHEET_DO_NAPRAWY = '4. Do naprawy';
const SHEET_MAPOWANIE = '3. Mapowanie produktów';

function buildHandleRemap({ missingHandles, products }) {
  const rowsNaprawy = readSheet(ARCH_FILE, SHEET_DO_NAPRAWY);
  const rowsMapowanie = readSheet(ARCH_FILE, SHEET_MAPOWANIE);

  // metoda 1: arkusz4 — stary handle (z "/products/...") -> proponowany nowy handle
  const arkusz4Map = new Map();
  for (const r of rowsNaprawy) {
    const url = norm(r['Handle / URL']);
    if (!url.startsWith('/products/')) continue;
    const proposed = norm(r['Nowy slug / nazwa']);
    if (!proposed) continue;
    arkusz4Map.set(url.slice('/products/'.length), proposed);
  }

  // metoda 2: tytul — stary handle -> "Obecna nazwa (H1)" z arkusza mapowania
  const titleByOldHandle = new Map();
  for (const r of rowsMapowanie) {
    const h = norm(r['Handle (obecny)']);
    if (!h) continue;
    titleByOldHandle.set(h, norm(r['Obecna nazwa (H1)']));
  }

  // znormalizowany tytul produktu w sklepie -> lista produktow o tym tytule
  const storeTitleIndex = new Map();
  for (const p of products.values()) {
    const key = normalizeTitle(p.title);
    if (!storeTitleIndex.has(key)) storeTitleIndex.set(key, []);
    storeTitleIndex.get(key).push(p);
  }

  const storeHandles = [...products.keys()];
  const rows = [];

  for (const oldHandle of missingHandles) {
    // 1. arkusz4
    const candidate4 = arkusz4Map.get(oldHandle);
    if (candidate4 && products.has(candidate4)) {
      rows.push({
        stary_handle: oldHandle,
        proponowany_handle: candidate4,
        metoda: 'arkusz4',
        dystans: '',
        tytul_w_sklepie: products.get(candidate4).title,
        pewnosc: 'wysoka',
      });
      continue;
    }

    // 2. tytul — trafienie tylko przy dokladnie jednym kandydacie
    const expectedTitle = titleByOldHandle.get(oldHandle);
    if (expectedTitle) {
      const matches = storeTitleIndex.get(normalizeTitle(expectedTitle)) ?? [];
      if (matches.length === 1) {
        rows.push({
          stary_handle: oldHandle,
          proponowany_handle: matches[0].handle,
          metoda: 'tytul',
          dystans: '',
          tytul_w_sklepie: matches[0].title,
          pewnosc: 'wysoka',
        });
        continue;
      }
    }

    // 3. podobienstwo — Levenshtein, dystans <= 4, drugi kandydat wyraznie gorszy
    // ("wyraznie gorszy" = margines >= 2, zeby odrzucic remisy/prawie-remisy)
    let best = null;
    let secondBest = null;
    for (const h of storeHandles) {
      const d = levenshtein(oldHandle, h);
      if (best === null || d < best.d) {
        secondBest = best;
        best = { h, d };
      } else if (secondBest === null || d < secondBest.d) {
        secondBest = { h, d };
      }
    }
    const margin = best && secondBest ? secondBest.d - best.d : Infinity;
    if (best && best.d <= 4 && margin >= 2) {
      rows.push({
        stary_handle: oldHandle,
        proponowany_handle: best.h,
        metoda: 'podobienstwo',
        dystans: best.d,
        tytul_w_sklepie: products.get(best.h)?.title ?? '',
        pewnosc: 'niska',
      });
      continue;
    }

    // brak trafienia
    rows.push({
      stary_handle: oldHandle,
      proponowany_handle: '',
      metoda: 'brak',
      dystans: '',
      tytul_w_sklepie: '',
      pewnosc: '',
    });
  }

  return rows;
}

async function main() {
  // Wszystkie arkusze czytamy PRZED jakimkolwiek zapytaniem do Shopify —
  // baseline (Krok 4) musi zablokowac dalsze dzialanie zanim skrypt uderzy w API.
  const rowsP = readSheet('1_produkty.xlsx', 'Products');
  const rowsSC = readSheet('2_kolekcje.xlsx', 'Smart Collections');
  const rowsCC = readSheet('2_kolekcje.xlsx', 'Custom Collections');
  const rowsM = readSheet('3_menu_i_redirecty.xlsx', 'Menus');
  const rowsR = readSheet('3_menu_i_redirecty.xlsx', 'Redirects');

  assertBaseline({ rowsP, rowsSC, rowsCC, rowsM, rowsR });

  console.log('Pobieram stan sklepu...');
  const [shop, products, collections, redirects] = await Promise.all([
    fetchShopName(),
    fetchAllProducts(),
    fetchAllCollections(),
    fetchRedirects(),
  ]);

  report.shop = { name: shop.name, domain: shop.myshopifyDomain };
  console.log(`Sklep: ${shop.name} (${shop.myshopifyDomain})`);
  console.log(
    `Produkty w sklepie: ${products.size} | Kolekcje: ${collections.size} | Redirecty: ${
      redirects.available ? redirects.map.size : 'NIEDOSTĘPNE (brak scope read_url_redirects)'
    }\n`
  );

  // --- 1. Produkty -------------------------------------------------------
  for (const r of rowsP) {
    const handle = norm(r['Handle']);
    if (!handle) continue;
    const p = products.get(handle);
    if (!p) {
      report.produkty.brakujace.push(handle);
      continue;
    }
    report.produkty.ok++;

    const newTitle = norm(r['Metafield: title_tag']);
    const oldTitle = norm(p.seo?.title);
    if (newTitle && newTitle !== oldTitle) {
      report.produkty.zmienioneTytulySeo.push({ handle, z: oldTitle || '(puste)', na: newTitle });
    }

    const tags = norm(r['Tags']);
    if (tags) {
      const wanted = tags.split(',').map((t) => t.trim()).filter(Boolean);
      const have = new Set(p.tags);
      const missing = wanted.filter((t) => !have.has(t));
      if (missing.length) report.produkty.tagiDoDodania.push({ handle, tagi: missing });
    }
  }

  // --- 2. Kolekcje -------------------------------------------------------
  for (const r of rowsSC) {
    const handle = norm(r['Handle']);
    if (!handle) continue;
    const existing = collections.get(handle);
    if (!existing) {
      report.kolekcje.doUtworzenia.push({ handle, typ: 'smart', regula: norm(r['Rule: Condition']) });
      continue;
    }
    if (!existing.ruleSet) {
      // istnieje jako kolekcja reczna -> Shopify nie pozwala dorobic ruleSet
      report.kolekcje.konfliktTypu.push({
        handle,
        problem: 'istnieje jako kolekcja RECZNA, plik chce SMART',
        produktowTeraz: existing.productsCount?.count ?? null,
        tytulTeraz: existing.title,
      });
    } else {
      report.kolekcje.istniejaceDoAktualizacji.push({
        handle,
        typ: 'smart',
        regulaTeraz: existing.ruleSet.rules.map((x) => `${x.column}/${x.relation}/${x.condition}`).join(' + '),
        regulaWPliku: `TAG/EQUALS/${norm(r['Rule: Condition'])}`,
      });
    }
    report.kolekcje.ok++;
  }

  // custom: pierwszy wiersz na handle niesie metadane, kolejne tylko produkty
  const customByHandle = new Map();
  for (const r of rowsCC) {
    const handle = norm(r['Handle']);
    if (!handle) continue;
    if (!customByHandle.has(handle)) customByHandle.set(handle, { meta: null, produkty: [] });
    const entry = customByHandle.get(handle);
    if (norm(r['Command'])) entry.meta = r;
    const ph = norm(r['Product: Handle']);
    if (ph) entry.produkty.push(ph);
  }

  for (const [handle, entry] of customByHandle) {
    const existing = collections.get(handle);
    if (!existing) {
      report.kolekcje.doUtworzenia.push({ handle, typ: 'custom', produktow: entry.produkty.length });
    } else if (existing.ruleSet) {
      report.kolekcje.konfliktTypu.push({
        handle,
        problem: 'istnieje jako kolekcja SMART, plik chce RECZNA',
        tytulTeraz: existing.title,
      });
    } else {
      report.kolekcje.istniejaceDoAktualizacji.push({
        handle,
        typ: 'custom',
        produktowTeraz: existing.productsCount?.count ?? null,
        produktowWPliku: entry.produkty.length,
        tytulTeraz: existing.title,
        tytulWPliku: norm(entry.meta?.['Title']),
      });
    }
    for (const ph of entry.produkty) {
      if (!products.has(ph)) report.produktyWKolekcjach.brakujaceHandle.push({ kolekcja: handle, produkt: ph });
    }
  }

  // --- 3. Pokrycie regul smart po zaimportowaniu tagow --------------------
  const tagsAfterImport = new Map(); // tag -> liczba produktow
  for (const r of rowsP) {
    const tags = norm(r['Tags']);
    const handle = norm(r['Handle']);
    const existing = products.get(handle);
    const all = new Set(existing ? existing.tags : []);
    if (tags) tags.split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => all.add(t));
    for (const t of all) tagsAfterImport.set(t, (tagsAfterImport.get(t) || 0) + 1);
  }
  for (const r of rowsSC) {
    const cond = norm(r['Rule: Condition']);
    report.smartRuleCoverage.push({
      kolekcja: norm(r['Handle']),
      tag: cond,
      produktowPoImporcie: tagsAfterImport.get(cond) || 0,
    });
  }

  // --- 4. Menu -----------------------------------------------------------
  const wszystkieHandleZPliku = new Set([
    ...rowsSC.map((r) => norm(r['Handle'])),
    ...customByHandle.keys(),
  ]);
  for (const r of rowsM) {
    if (norm(r['Menu Item: Resource Type']) !== 'COLLECTION') continue;
    const h = norm(r['Menu Item: Resource Handle']);
    if (!h) continue;
    if (!collections.has(h) && !wszystkieHandleZPliku.has(h)) {
      report.menu.brakujaceKolekcje.push({ pozycja: norm(r['Menu Item: Title']), handle: h });
    }
  }

  // --- 5. Redirecty ------------------------------------------------------
  report.redirecty.available = redirects.available;
  for (const r of rowsR) {
    const p = norm(r['Path']);
    if (!p) continue;
    if (redirects.available && redirects.map.has(p)) {
      report.redirecty.juzIstnieje.push({ path: p, target: redirects.map.get(p).target });
    }
    const m = p.match(/^\/collections\/(.+)$/);
    if (m && collections.has(m[1])) {
      report.redirecty.zasobBlokujacy.push({
        path: p,
        uwaga: `kolekcja "${m[1]}" nadal istnieje - redirect 301 nie zadziala, dopoki jej nie usuniesz`,
      });
    }
  }

  // ---------------------------------------------------------------- print
  const line = (s) => console.log(s);
  line('='.repeat(70));
  line('NAZWA SKLEPU');
  line('='.repeat(70));
  line(`  teraz: "${shop.name}"  ${shop.name === 'Majątek Mała Wieś' ? 'OK' : '<-- do zmiany na "Majątek Mała Wieś"'}`);

  line('');
  line('='.repeat(70));
  line('1_produkty.xlsx');
  line('='.repeat(70));
  line(`  handle znalezione w sklepie: ${report.produkty.ok} / ${rowsP.length}`);
  if (report.produkty.brakujace.length) {
    line(`  BRAK w sklepie (${report.produkty.brakujace.length}) - te wiersze przepadna:`);
    report.produkty.brakujace.forEach((h) => line(`    - ${h}`));
  }
  line(`  tytuly SEO do zmiany: ${report.produkty.zmienioneTytulySeo.length}`);
  line(`  produkty z brakujacymi tagami: ${report.produkty.tagiDoDodania.length}`);

  line('');
  line('='.repeat(70));
  line('2_kolekcje.xlsx');
  line('='.repeat(70));
  line(`  do utworzenia: ${report.kolekcje.doUtworzenia.length}`);
  report.kolekcje.doUtworzenia.forEach((c) => line(`    + ${c.handle} (${c.typ})`));
  line(`  istnieja, beda nadpisane: ${report.kolekcje.istniejaceDoAktualizacji.length}`);
  report.kolekcje.istniejaceDoAktualizacji.forEach((c) =>
    line(`    ~ ${c.handle} (${c.typ}) "${c.tytulTeraz ?? ''}"`)
  );
  if (report.kolekcje.konfliktTypu.length) {
    line(`  KONFLIKT TYPU (${report.kolekcje.konfliktTypu.length}) - wymaga usuniecia i odtworzenia:`);
    report.kolekcje.konfliktTypu.forEach((c) => line(`    ! ${c.handle}: ${c.problem}`));
  }
  if (report.produktyWKolekcjach.brakujaceHandle.length) {
    line(`  Produkty przypisane do kolekcji, ktorych nie ma w sklepie (${report.produktyWKolekcjach.brakujaceHandle.length}):`);
    report.produktyWKolekcjach.brakujaceHandle.forEach((x) => line(`    - ${x.produkt}  (w kolekcji ${x.kolekcja})`));
  }

  line('');
  line('  Pokrycie regul smart po zaimportowaniu tagow:');
  report.smartRuleCoverage.forEach((c) => {
    const flag = c.produktowPoImporcie === 0 ? '  <-- PUSTA KOLEKCJA' : '';
    line(`    ${String(c.produktowPoImporcie).padStart(3)}  ${c.kolekcja}  (${c.tag})${flag}`);
  });

  line('');
  line('='.repeat(70));
  line('3_menu_i_redirecty.xlsx');
  line('='.repeat(70));
  if (report.menu.brakujaceKolekcje.length) {
    line(`  Pozycje menu wskazujace na nieistniejace kolekcje (${report.menu.brakujaceKolekcje.length}):`);
    report.menu.brakujaceKolekcje.forEach((x) => line(`    - ${x.pozycja} -> ${x.handle}`));
  } else {
    line('  Wszystkie pozycje menu maja pokrycie w kolekcjach (istniejacych lub z kroku 2). OK');
  }
  if (!report.redirecty.available) {
    line('  NIEDOSTĘPNE: token nie ma scope do odczytu redirectow (ACCESS_DENIED) - "juz istnieje" nie sprawdzone.');
  }
  report.redirecty.juzIstnieje.forEach((x) => line(`  Redirect juz istnieje: ${x.path} -> ${x.target}`));
  report.redirecty.zasobBlokujacy.forEach((x) => line(`  UWAGA: ${x.uwaga}`));

  // --- 6. Remapowanie handli (Krok 3) — tylko propozycja, nic nie stosuje --
  const missingHandles = [...new Set([
    ...report.produkty.brakujace,
    ...report.produktyWKolekcjach.brakujaceHandle.map((x) => x.produkt),
  ])];
  const remapRows = buildHandleRemap({ missingHandles, products });
  report.remapHandle = remapRows;

  const remapCsvPath = path.join(DIR, 'remap-handle.csv');
  writeCsv(
    remapCsvPath,
    ['stary_handle', 'proponowany_handle', 'metoda', 'dystans', 'tytul_w_sklepie', 'pewnosc'],
    remapRows
  );

  line('');
  line('='.repeat(70));
  line('REMAPOWANIE HANDLI (propozycja, nie stosowana)');
  line('='.repeat(70));
  const byMetoda = { arkusz4: 0, tytul: 0, podobienstwo: 0, brak: 0 };
  remapRows.forEach((r) => { byMetoda[r.metoda] = (byMetoda[r.metoda] ?? 0) + 1; });
  line(`  Brakujacych handli do zremapowania: ${remapRows.length}`);
  line(`  arkusz4 (wysoka pewnosc): ${byMetoda.arkusz4}`);
  line(`  tytul (wysoka pewnosc): ${byMetoda.tytul}`);
  line(`  podobienstwo (niska pewnosc): ${byMetoda.podobienstwo}`);
  line(`  brak trafienia: ${byMetoda.brak}`);
  line(`  Zapisano do ${remapCsvPath}`);

  line('');
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), 'utf8');
    line(`Pelny raport zapisany do ${JSON_OUT}`);
  }
  line('Skrypt nic nie zapisal w Shopify.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
