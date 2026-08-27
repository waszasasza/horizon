#!/usr/bin/env node
// Import 19 zestawów prezentowych z Zestawy-prezentowe-ecommerce.xlsx (scripts/
// zestawy-prezentowe.xlsx) przez Admin API. W odróżnieniu od import-wina.mjs — te
// produkty NIE ISTNIEJĄ w sklepie, więc Etap 1 je tworzy (status: DRAFT), a Etap 2
// dogrywa metapola dopiero po utworzeniu.
//
// Zakres po diagnozie Etapu 0 (patrz raport w rozmowie) — świadomie WĄŻSZY niż cały
// arkusz zakładał:
//   - Zapisywane: custom.cechy, custom.faq, custom.przechowywanie, custom.skad_pochodzi,
//     custom.wartosci_odzywcze_i_alergeny, descriptionHtml, price, category, tag linii,
//     tag "18+" (16 zestawów z alkoholem — lista niżej, zweryfikowana ręcznie po
//     składnikach "W zestawie:", nie po nazwie linii katalogowej).
//   - CELOWO pomijane, do braki-zestawy.md, nie do kodu: "Polecamy do" (17 unikalnych
//     wartości to okazje, nie parowanie z jedzeniem — zły metaobiekt, decyzja produktowa
//     na później), "Karta historii" (8 brakujących metaobiektów wymaga tytuł/treść/obraz,
//     których arkusz nie daje), Wariant/Dominujące nuty/Tekst SEO/Karta produktu (puste
//     w całym arkuszu).
//
// Kategoria: fb-2-8-1 "Alcohol Gift Baskets" dla 16 zestawów z alkoholem, fb-2-8
// "Food Gift Baskets" dla pozostałych 3 — ta sama granica co tag 18+.
//
// Użycie:
//   node import-zestawy.mjs --file ./zestawy-prezentowe.xlsx            (dry-run)
//   node import-zestawy.mjs --file ./zestawy-prezentowe.xlsx --commit    (realny zapis)

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import xlsx from 'xlsx';
import { fetchAllMetaobjects } from './lib/fetch-metaobjects.mjs';

dotenv.config();

const API_VERSION = '2026-01';
const SHEET_DANE = 'Dane';
const SHEET_CENY = 'Ceny';
const CENY_HEADER_ROW_INDEX = 2; // wiersz 3 arkusza (0-indeksowany) — potwierdzone w Etapie 0

const CATEGORY_ALCOHOL = 'gid://shopify/TaxonomyCategory/fb-2-8-1'; // Alcohol Gift Baskets
const CATEGORY_PLAIN = 'gid://shopify/TaxonomyCategory/fb-2-8'; // Food Gift Baskets

// Zweryfikowane ręcznie po realnych składnikach "W zestawie:" w Etapie 0 (nie po
// nazwie linii katalogowej — "Linia Niewinna" nie jest wiarygodnym predyktorem).
// Potwierdzone przez użytkownika po korekcie (wódka w "Ślad tradycji", cydr w
// "Golden Pairing", piwo w "Viva la chwila" — przeoczone przy pierwszym liczeniu).
const ALCOHOL_TITLES = new Set([
  'Spritz z Małej Wsi',
  'Bukiet Zmysłów',
  'Prosto z natury',
  'The Pola Way',
  'W sam raz',
  'Smak chwili',
  'Un momento',
  'Hugo z Małej Wsi',
  'Książęcy Prezent',
  'Ślad tradycji',
  'Riesling w roli głównej',
  'Dobry Gust',
  'Fenix Mood',
  'Golden Pairing',
  'Rouge Moment',
  'Viva la chwila',
]);

const RATE_LIMIT_DELAY_MS = 550;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const METAFIELD_BATCH_SIZE = 4; // max 4 produkty/wywołanie metafieldsSet — do 5 metapól/produkt = 20, pod limitem 25

// Deliverable dla klienta — celowo POZA scripts/, żeby nie wylądował w commicie razem z kodem.
const GAPS_FILE = path.join(process.env.HOME ?? '.', 'Desktop', 'braki-zestawy.md');

// 8 wartości "Karta historii" bez metaobiektu karta_historii (wymaga tytuł/treść/obraz,
// których arkusz nie daje) — zweryfikowane w Etapie 0, świadomie NIE tworzone.
const MISSING_KARTA_HISTORII = [
  'Pałacowy sad',
  'Zbiór owoców',
  'Spiżarnia Książęca',
  'Serce Mazowsza',
  'Dziedzictwo Winnicy',
  'Pasieka Książęca',
  'Ludzie Małej Wsi',
  'Tłocznia Książęca',
];

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

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * "Opis karty" -> descriptionHtml. Zdecydowane w Etapie 0: <p> dla zwykłych linii,
 * <ul><li> dla linii zaczynających się od "•" (bez zmiany treści, tylko struktura).
 */
function buildDescriptionHtml(rawText) {
  const lines = String(rawText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const html = [];
  let ulOpen = false;
  for (const line of lines) {
    if (line.startsWith('•')) {
      if (!ulOpen) {
        html.push('<ul>');
        ulOpen = true;
      }
      html.push(`<li>${escapeHtml(line.replace(/^•\s*/, ''))}</li>`);
    } else {
      if (ulOpen) {
        html.push('</ul>');
        ulOpen = false;
      }
      html.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (ulOpen) html.push('</ul>');
  return html.join('');
}

/** Płaski tekst (bez \n w danych tego arkusza, ale kod nie zakłada tego) -> rich_text_field. */
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

function readSheets(filePath) {
  const workbook = xlsx.readFile(filePath);
  if (!workbook.SheetNames.includes(SHEET_DANE)) {
    throw new Error(`Brak arkusza "${SHEET_DANE}". Dostępne: ${workbook.SheetNames.join(', ')}`);
  }
  if (!workbook.SheetNames.includes(SHEET_CENY)) {
    throw new Error(`Brak arkusza "${SHEET_CENY}". Dostępne: ${workbook.SheetNames.join(', ')}`);
  }
  const dane = xlsx.utils.sheet_to_json(workbook.Sheets[SHEET_DANE], { defval: '' });

  const cenyRaw = xlsx.utils.sheet_to_json(workbook.Sheets[SHEET_CENY], { header: 1, defval: '' });
  const cenyRows = cenyRaw.slice(CENY_HEADER_ROW_INDEX + 1).filter((r) => r.some((c) => c !== ''));
  const ceny = cenyRows.map((r) => ({ nr: r[0], nazwa: String(r[1]).trim(), cena: r[2], linia: String(r[3]).trim() }));

  return { dane, ceny };
}

/** Złączenie Dane.Tytuł produktu <-> Ceny.Nazwa zestawu. Przerywa (nie dopasowuje
 * po podobieństwie), jeśli którykolwiek wiersz nie ma dokładnego dopasowania 1:1. */
function joinSheets(dane, ceny) {
  const cenyByName = new Map(ceny.map((c) => [c.nazwa, c]));
  const joined = [];
  const missing = [];
  for (const row of dane) {
    const title = String(row['Tytuł produktu']).trim();
    const cenyRow = cenyByName.get(title);
    if (!cenyRow) {
      missing.push(title);
      continue;
    }
    joined.push({ dane: row, ceny: cenyRow });
  }
  if (missing.length > 0) {
    throw new Error(
      `Złączenie Dane<->Ceny nie jest 1:1 — brak dopasowania po tytule dla: ${missing.join(', ')}. ` +
        'Przerywam zgodnie z instrukcją (bez dopasowywania po podobieństwie).'
    );
  }
  return joined;
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

const PRODUCT_CREATE_MUTATION = /* GraphQL */ `
  mutation MmwProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        handle
        variants(first: 1) {
          nodes { id }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const VARIANT_PRICE_MUTATION = /* GraphQL */ `
  mutation MmwSetPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation MmwMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message code }
    }
  }
`;

function buildRows(dane, ceny, cechyMap, faqMap) {
  const joined = joinSheets(dane, ceny);
  const rows = [];
  for (const { dane: row, ceny: cenyRow } of joined) {
    const title = String(row['Tytuł produktu']).trim();
    const handle = String(row['Handle']).trim();
    const isAlcohol = ALCOHOL_TITLES.has(title);
    const price = Number(cenyRow.cena);
    const linia = cenyRow.linia;

    const tags = [linia];
    if (isAlcohol) tags.push('18+');

    const cechyLabels = ['Cecha 1', 'Cecha 2', 'Cecha 3', 'Cecha 4', 'Cecha 5']
      .map((c) => row[c])
      .filter((v) => !isBlank(v));
    const cechyGids = [];
    const cechyMissing = [];
    for (const label of cechyLabels) {
      const gid = cechyMap.get(normalizeLabel(label));
      if (gid) cechyGids.push(gid);
      else cechyMissing.push(label);
    }

    const faqQuestions = ['FAQ 1', 'FAQ 2', 'FAQ 3', 'FAQ 4'].map((c) => row[c]).filter((v) => !isBlank(v));
    const faqGids = [];
    const faqMissing = [];
    for (const q of faqQuestions) {
      const gid = faqMap.get(normalizeLabel(q));
      if (gid) faqGids.push(gid);
      else faqMissing.push(q);
    }

    if (cechyMissing.length > 0 || faqMissing.length > 0) {
      throw new Error(
        `${handle}: nieoczekiwany brak w cechy/FAQ mimo weryfikacji w Etapie 0 — cechy: [${cechyMissing.join(', ')}], FAQ: [${faqMissing.join(', ')}]`
      );
    }

    const przechowywanie = isBlank(row['Przechowywanie']) ? null : String(row['Przechowywanie']).trim();
    const skadPochodzi = isBlank(row['Skąd pochodzi']) ? null : String(row['Skąd pochodzi']).trim();
    const wartosciRaw = isBlank(row['Wartości odżywcze i alergeny']) ? null : String(row['Wartości odżywcze i alergeny']).trim();
    const opisKarty = isBlank(row['Opis karty']) ? null : String(row['Opis karty']);

    rows.push({
      title,
      handle,
      price,
      linia,
      isAlcohol,
      tags,
      category: isAlcohol ? CATEGORY_ALCOHOL : CATEGORY_PLAIN,
      descriptionHtml: opisKarty ? buildDescriptionHtml(opisKarty) : null,
      cechyGids,
      faqGids,
      przechowywanie,
      skadPochodzi,
      wartosciOdzywczeRaw: wartosciRaw,
    });
  }
  return rows;
}

// --- braki-zestawy.md: dopasowanie składników "W zestawie:" do katalogu ---
// Dopasowanie po podobieństwie słów (nie exact match — nazwy w arkuszu mają opisowe
// dopiski typu "- wytrawne białe wino", których nie ma w tytule produktu). Próg 50%
// ustalony empirycznie: powyżej niego prawdziwe produkty (Riesling 2025, Blanc 2025,
// Wódka Walicki...) trafiają poprawnie mimo dopisków; poniżej niego to już realne braki
// (kawa, batony, ciastka) albo niepewne dopasowania do zgłoszenia człowiekowi, nie do
// automatycznego rozstrzygnięcia.
function normalizeForMatch(s) {
  return s.toLowerCase().replace(/[.,\-–—×]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) {
  return normalizeForMatch(s).split(' ').filter((w) => w.length > 2);
}
function overlapScore(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0) return 0;
  let hits = 0;
  for (const w of ta) if (tb.has(w)) hits++;
  return hits / ta.size;
}
function checkIngredients(dane, products) {
  const seen = new Map(); // nazwa -> { setTitles: [] }
  for (const row of dane) {
    const setTitle = row['Tytuł produktu'];
    const lines = String(row['Opis karty'])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('•'));
    for (const l of lines) {
      const item = l.replace(/^•\s*/, '').replace(/^\d+\s*×\s*/, '');
      const nameGuess = item.replace(/\s*\d+([.,]\d+)?\s*(ml|g|l)\.?$/i, '').trim();
      if (!seen.has(nameGuess)) seen.set(nameGuess, []);
      seen.get(nameGuess).push(setTitle);
    }
  }
  const notFound = [];
  const uncertain = [];
  for (const [name, sets] of seen) {
    let best = { score: 0, title: null };
    for (const p of products) {
      const s = overlapScore(name, p.title);
      if (s > best.score) best = { score: s, title: p.title };
    }
    if (best.score === 0) notFound.push({ name, sets });
    else if (best.score < 0.5) uncertain.push({ name, sets, best });
  }
  return { totalUnique: seen.size, notFound, uncertain };
}

function buildGapsMarkdown({ rows, dane, ingredientCheck }) {
  const lines = [];
  lines.push('# Braki i uwagi do zestawów prezentowych');
  lines.push('');
  lines.push(
    'Wygenerowane automatycznie przy imporcie z `zestawy-prezentowe.xlsx`. Zakres importu jest ' +
      'świadomie węższy niż cały arkusz — ten plik jest tu ważniejszym deliverable niż sam import, ' +
      'bo opisuje wszystko, co zostało z arkusza NIE zapisane i dlaczego.'
  );
  lines.push('');

  lines.push('## Brakujące dane produktowe');
  lines.push('');
  lines.push(
    'Żaden z 19 zestawów nie ma dziś SKU, wagi, stanu magazynowego ani zdjęcia — nie były w ' +
      'arkuszu i nie zostały wymyślone. Lista do wypełnienia:'
  );
  lines.push('');
  lines.push('| Handle | Tytuł | SKU | Waga | Stan magazynowy | Zdjęcie |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| \`${r.handle}\` | ${r.title} | | | | |`);
  }
  lines.push('');

  lines.push('## SKU komponentów, nie tylko zestawu');
  lines.push('');
  lines.push(
    'Zestaw prezentowy przy sprzedaży zdejmuje ze stanu magazynowego poszczególne produkty ' +
      'składowe (butelkę wina, słoik konfitury, czekoladę...), a nie jedną sztukę "zestawu" jako ' +
      'osobnego bytu magazynowego — więc SAMO SKU zestawu nie wystarczy do obsługi stanów. ' +
      'Potrzebne są SKU wszystkich komponentów wymienionych w „W zestawie:" dla każdej z 19 pozycji, ' +
      'żeby sprzedaż zestawu mogła poprawnie obniżać zapasy komponentów.'
  );
  lines.push('');

  lines.push('## Zestaw nr 15');
  lines.push('');
  lines.push(
    'Numeracja w arkuszu `Ceny` idzie 14 → 16, bez pozycji 15. Czy to wycofany zestaw, czy coś, ' +
      'co wypadło z dostawy? Nie ma go w imporcie (bo go nie ma w arkuszu), ale warto potwierdzić, ' +
      'że to celowa luka, nie błąd przy eksporcie pliku.'
  );
  lines.push('');

  lines.push('## Składniki, których nie ma w sklepie');
  lines.push('');
  lines.push(
    `Przejechane wszystkie 19 list „W zestawie:", ${ingredientCheck.totalUnique} unikalnych pozycji, ` +
      'dopasowane do katalogu po podobieństwie słów (nie exact match — nazwy w arkuszu mają opisowe ' +
      'dopiski typu "- wytrawne białe wino", których nie ma w tytule produktu).'
  );
  lines.push('');
  lines.push(`**Brak jakiegokolwiek dopasowania w katalogu (${ingredientCheck.notFound.length}):**`);
  lines.push('');
  for (const item of ingredientCheck.notFound) {
    lines.push(`- „${item.name}" — w zestawach: ${[...new Set(item.sets)].join(', ')}`);
  }
  lines.push('');
  lines.push(
    `**Niepewne dopasowanie, do ręcznego sprawdzenia (${ingredientCheck.uncertain.length}):**`
  );
  lines.push('');
  for (const item of ingredientCheck.uncertain) {
    lines.push(
      `- „${item.name}" — w zestawach: ${[...new Set(item.sets)].join(', ')} | najbliższy kandydat w katalogu: „${item.best.title}" (${Math.round(item.best.score * 100)}% wspólnych słów)`
    );
  }
  lines.push('');
  lines.push(
    '**Rozmiar wariantu, którego nie ma:** `Blanc 2025` istnieje w katalogu, ale wyłącznie jako ' +
      'jeden wariant "Default Title" (odpowiadający butelce 750 ml, cena 109 zł). Zestaw „W sam raz" ' +
      'wymaga butelki 187 ml — ta pojemność nie ma dziś odpowiadającego wariantu/SKU w sklepie.'
  );
  lines.push('');

  lines.push('## Puste kolumny w arkuszu');
  lines.push('');
  const emptyCols = [
    ['FAQ 4', dane.filter((d) => String(d['FAQ 4']).trim() !== '').length],
    ['Karta historii 4', dane.filter((d) => String(d['Karta historii 4']).trim() !== '').length],
    ['Tekst SEO', dane.filter((d) => String(d['Tekst SEO']).trim() !== '').length],
    ['Karta produktu (nazwa pliku)', dane.filter((d) => String(d['Karta produktu (nazwa pliku)']).trim() !== '').length],
  ];
  for (const [col, filled] of emptyCols) {
    lines.push(`- **${col}**: wypełnione w ${filled}/${dane.length} wierszy.`);
  }
  lines.push('');

  lines.push('## "Polecamy do" — pominięte w całości, decyzja produktowa, nie importowa');
  lines.push('');
  lines.push(
    'Nagłówek kolumny przyszedł z szablonu win, ale niesie inną treść: w arkuszu win to propozycje ' +
      'parowania z jedzeniem (metaobiekt `polecamy_do`, np. "Dziczyzna", "Sushi"), a tu — okazje/konteksty ' +
      'użycia zestawu. Zapisanie ich do `custom.polecamy_do` zaśmieciłoby komponent kart win. ' +
      '17 unikalnych wartości do rozstrzygnięcia, czym mają być (filtr? kolekcje sezonowe? coś innego?):'
  );
  lines.push('');
  const polecamyValues = new Set();
  for (const d of dane) {
    ['Polecamy do 1', 'Polecamy do 2', 'Polecamy do 3', 'Polecamy do 4'].forEach((c) => {
      const v = String(d[c]).trim();
      if (v) polecamyValues.add(v);
    });
  }
  for (const v of [...polecamyValues].sort()) lines.push(`- ${v}`);
  lines.push('');

  lines.push('## "Karta historii" — 8 wartości bez metaobiektu, nie utworzone');
  lines.push('');
  lines.push(
    'Metaobiekt `karta_historii` wymaga tytułu, treści i obrazu — arkusz zestawów daje wyłącznie ' +
      'etykietę. To głównie nazwy miejsc i marek Majątku, do uzupełnienia treścią, jeśli mają powstać:'
  );
  lines.push('');
  for (const v of MISSING_KARTA_HISTORII) lines.push(`- ${v}`);
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Brak pliku wejściowego. Użycie: node import-zestawy.mjs --file <ścieżka.xlsx> [--commit]');
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

  const { dane, ceny } = readSheets(filePath);
  console.log(`Wczytano ${dane.length} wierszy z "${SHEET_DANE}", ${ceny.length} wierszy z "${SHEET_CENY}".`);

  console.log('\nPobieram cecha_produktu i pytanie_faq do rozwiązania referencji...');
  const [cechyList, faqList] = await Promise.all([
    fetchAllMetaobjects({ store, token, graphql: graphqlRawWithRetry, type: 'cecha_produktu' }),
    fetchAllMetaobjects({ store, token, graphql: graphqlRawWithRetry, type: 'pytanie_faq' }),
  ]);
  const cechyMap = new Map(
    cechyList.map((m) => [normalizeLabel(m.fields.find((f) => f.key === 'etykieta')?.value ?? ''), m.id])
  );
  const faqMap = new Map(
    faqList.map((m) => [normalizeLabel(m.fields.find((f) => f.key === 'pytanie')?.value ?? ''), m.id])
  );
  console.log(`  cecha_produktu: ${cechyList.length}, pytanie_faq: ${faqList.length}`);

  const rows = buildRows(dane, ceny, cechyMap, faqMap);

  console.log('Pobieram katalog produktów do sprawdzenia składników "W zestawie:"...');
  const productsData = await graphqlWithRetry({
    store,
    token,
    query: /* GraphQL */ `
      query MmwAllProducts {
        products(first: 250) {
          nodes { handle title }
        }
      }
    `,
    variables: {},
  });
  const allProducts = productsData.products.nodes;
  const ingredientCheck = checkIngredients(dane, allProducts);
  const gapsMarkdown = buildGapsMarkdown({ rows, dane, ingredientCheck });
  writeFileSync(GAPS_FILE, gapsMarkdown, 'utf8');
  console.log(`Zapisano ${GAPS_FILE}.`);

  console.log('\n--- Plan (dry-run) ---');
  for (const r of rows) {
    console.log(`\n${r.handle} (${r.title})`);
    console.log(`  cena: ${r.price.toFixed(2)} zł | linia: ${r.linia} | 18+: ${r.isAlcohol ? 'tak' : 'nie'}`);
    console.log(`  tagi: ${r.tags.join(', ')}`);
    console.log(`  kategoria: ${r.category}`);
    console.log(`  descriptionHtml: ${r.descriptionHtml ? r.descriptionHtml.length + ' znaków' : '(brak)'}`);
    const metaSummary = [
      r.cechyGids.length > 0 ? `cechy=${r.cechyGids.length}` : null,
      r.faqGids.length > 0 ? `faq=${r.faqGids.length}` : null,
      r.przechowywanie ? `przechowywanie=${r.przechowywanie.length}zn` : null,
      r.skadPochodzi ? `skad_pochodzi=${r.skadPochodzi.length}zn` : null,
      r.wartosciOdzywczeRaw ? `wartosci_odzywcze_i_alergeny=${r.wartosciOdzywczeRaw.length}zn` : null,
    ].filter(Boolean);
    console.log(`  metapola do zapisania: ${metaSummary.join(', ') || '(brak)'}`);
  }

  console.log(`\n\nPodsumowanie: ${rows.length} zestawów, ${rows.filter((r) => r.isAlcohol).length} z tagiem 18+.`);

  if (args.dryRun) {
    console.log('\nDry-run zakończony. Aby zapisać, uruchom z flagą --commit.');
    return;
  }

  // --- Etap 1: utworzenie produktów (status: DRAFT) + cena ---
  console.log('\n=== Etap 1: tworzenie produktów (DRAFT) ===');
  const created = [];
  for (const r of rows) {
    const productInput = {
      title: r.title,
      handle: r.handle,
      status: 'DRAFT',
      category: r.category,
      tags: r.tags,
      descriptionHtml: r.descriptionHtml ?? '',
    };
    const data = await graphqlWithRetry({ store, token, query: PRODUCT_CREATE_MUTATION, variables: { product: productInput } });
    const userErrors = data.productCreate.userErrors;
    if (userErrors.length > 0) {
      console.log(`  BŁĄD (${r.handle}): ${JSON.stringify(userErrors)}`);
      console.log('  Przerywam — kolejne produkty NIE są tworzone.');
      process.exitCode = 1;
      return;
    }
    const product = data.productCreate.product;
    const variantId = product.variants.nodes[0].id;

    const priceData = await graphqlWithRetry({
      store,
      token,
      query: VARIANT_PRICE_MUTATION,
      variables: { productId: product.id, variants: [{ id: variantId, price: r.price.toFixed(2) }] },
    });
    const priceErrors = priceData.productVariantsBulkUpdate.userErrors;
    if (priceErrors.length > 0) {
      console.log(`  BŁĄD CENY (${r.handle}): ${JSON.stringify(priceErrors)}`);
      console.log('  Przerywam — kolejne produkty NIE są tworzone.');
      process.exitCode = 1;
      return;
    }

    console.log(`  OK — ${r.handle}: ${product.id}, cena ${r.price.toFixed(2)} zł`);
    created.push({ ...r, productId: product.id });
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // --- Etap 2: metapola, paczki po max 4 produkty ---
  console.log('\n=== Etap 2: metapola (paczki po max 4 produkty) ===');
  const toWrite = created
    .map((r) => {
      const metafields = [];
      if (r.cechyGids.length > 0) {
        metafields.push({ ownerId: r.productId, namespace: 'custom', key: 'cechy', type: 'list.metaobject_reference', value: JSON.stringify(r.cechyGids) });
      }
      if (r.faqGids.length > 0) {
        metafields.push({ ownerId: r.productId, namespace: 'custom', key: 'faq', type: 'list.metaobject_reference', value: JSON.stringify(r.faqGids) });
      }
      if (r.przechowywanie) {
        metafields.push({ ownerId: r.productId, namespace: 'custom', key: 'przechowywanie', type: 'multi_line_text_field', value: r.przechowywanie });
      }
      if (r.skadPochodzi) {
        metafields.push({ ownerId: r.productId, namespace: 'custom', key: 'skad_pochodzi', type: 'multi_line_text_field', value: r.skadPochodzi });
      }
      if (r.wartosciOdzywczeRaw) {
        metafields.push({
          ownerId: r.productId,
          namespace: 'custom',
          key: 'wartosci_odzywcze_i_alergeny',
          type: 'rich_text_field',
          value: JSON.stringify(buildRichTextFromFlatText(r.wartosciOdzywczeRaw)),
        });
      }
      return { handle: r.handle, metafields };
    })
    .filter((x) => x.metafields.length > 0);

  const batches = [];
  for (let i = 0; i < toWrite.length; i += METAFIELD_BATCH_SIZE) {
    batches.push(toWrite.slice(i, i + METAFIELD_BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const handles = batch.map((x) => x.handle);
    const metafields = batch.flatMap((x) => x.metafields);
    console.log(`\nPaczka ${b + 1}/${batches.length}: ${handles.join(', ')} (${metafields.length} pól)`);

    const json = await graphqlRawWithRetry({ store, token, query: METAFIELDS_SET_MUTATION, variables: { metafields } });
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
    if (b < batches.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`\nGotowe. Utworzono ${created.length} produktów (status: DRAFT), zapisano metapola w ${batches.length} paczkach.`);
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
