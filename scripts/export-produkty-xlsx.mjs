#!/usr/bin/env node
// Eksport XLSX do uzupełnienia danych produktów (wina / spożywcze), przez Admin GraphQL API.
// NIE Matrixify — własna apka, żeby ominąć limity. READ-ONLY względem Shopify (tylko GET
// przez query), zapisuje wyłącznie lokalne pliki .xlsx do scripts/eksport/ (gitignored).
//
// Użycie: node export-produkty-xlsx.mjs

import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { shopifyGraphQLWithRetry } from './lib/shopify-graphql.mjs';
import { fetchAllMetaobjects } from './lib/fetch-metaobjects.mjs';

dotenv.config();

const OUT_DIR = path.resolve('eksport');

// --- Konfiguracja kolumn (zatwierdzona w rozmowie) ---

const REF_LIST_FIELDS = [
  { key: 'cechy', metaobjectType: 'cecha_produktu', labelField: 'etykieta', count: 5, headerBase: 'Cecha' },
  { key: 'faq', metaobjectType: 'pytanie_faq', labelField: 'pytanie', count: 4, headerBase: 'FAQ' },
  { key: 'karty_historii', metaobjectType: 'karta_historii', labelField: 'tytul', count: 7, headerBase: 'Karta historii' },
  { key: 'polecamy_do', metaobjectType: 'polecamy_do', labelField: 'tytul', count: 8, headerBase: 'Polecamy do' },
];

const WARIANTY_COUNT = 8;

// Kolejność celowa: Wygląd (białe)/Wygląd (czerwone) sąsiadują (patrz Instrukcja — wypełnia
// się tylko jedną, zależnie od typu wina).
const WINE_SCALE_AXES = [
  { header: 'Wygląd (białe)', skalaHandle: 'wyglad-wina-biale' },
  { header: 'Wygląd (czerwone)', skalaHandle: 'wyglad-wina-czerwone' },
  { header: 'Aromat', skalaHandle: 'aromat' },
  { header: 'Kwasowość', skalaHandle: 'kwasowosc' },
  { header: 'Ciało', skalaHandle: 'cialo' },
];
const FOOD_SCALE_AXES = [
  { header: 'Słodkość', skalaHandle: 'slodkosc' },
  { header: 'Kwaśność', skalaHandle: 'kwasnosc' },
  { header: 'Konsystencja', skalaHandle: 'konsystencja' },
  { header: 'Gęstość', skalaHandle: 'gestosc' },
];

const TEXT_FIELDS = [
  { key: 'przechowywanie', header: 'Przechowywanie', richText: false },
  { key: 'skad_pochodzi', header: 'Skąd pochodzi', richText: false },
  { key: 'wartosci_odzywcze_i_alergeny', header: 'Wartości odżywcze i alergeny', richText: true },
  { key: 'opis_karty', header: 'Opis karty', richText: false },
  { key: 'dominujace_nuty', header: 'Dominujące nuty', richText: false },
  { key: 'tekst_seo', header: 'Tekst SEO', richText: true },
];

// Tytuły dokładnie takie, jak w katalogu (sprawdzone przez API) — po nich, nie po handle,
// bo handle "Balsamico jabłkowe" ma inaczej zakodowane polskie znaki niż tytuł.
const SAMPLE_TITLES = ['Książe Regent 2024', 'Balsamico jabłkowe'];

// Reguła D (zatwierdzona) — wypadają wina i wyraźny merch; "Zestaw Świąteczna chwila dla
// siebie" (productType puste) wyłączony jawnie, patrz raport Kroku 1 — brzmi jak
// zestaw prezentowy/kosmetyczny, nie jedzenie. Jeśli to błąd, zmień tu tę jedną linię.
const NON_FOOD_TYPES = new Set(['Dodatki', 'Akcesoria', 'Zestawy prezentowe', 'Kosmetyki Książęce', 'Wina']);
const FOOD_TITLE_EXCLUDE = new Set(['Zestaw Świąteczna chwila dla siebie']);

function isWine(p) {
  return p.productType === 'Wina';
}
function isFood(p) {
  if (isWine(p)) return false;
  if (NON_FOOD_TYPES.has(p.productType)) return false;
  if (p.productType === 'Oleje' && p.title.toLowerCase().includes('olejek do ciała')) return false;
  if (FOOD_TITLE_EXCLUDE.has(p.title)) return false;
  return true;
}

// --- GraphQL ---

const PRODUCTS_QUERY = /* GraphQL */ `
  query MmwExportProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      nodes {
        id
        title
        handle
        productType
        metafields(first: 50) {
          nodes { namespace key value }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const FILE_NODE_QUERY = /* GraphQL */ `
  query MmwFileNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on GenericFile { url }
      ... on MediaImage { image { url } }
    }
  }
`;

async function fetchAllProducts({ store, token }) {
  let cursor = null;
  const all = [];
  while (true) {
    const json = await shopifyGraphQLWithRetry({ store, token, query: PRODUCTS_QUERY, variables: { cursor } });
    if (json.errors) throw new Error(`products: ${JSON.stringify(json.errors)}`);
    all.push(...json.data.products.nodes);
    if (!json.data.products.pageInfo.hasNextPage) break;
    cursor = json.data.products.pageInfo.endCursor;
  }
  return all;
}

async function resolveFileName({ store, token, gid, cache }) {
  if (cache.has(gid)) return cache.get(gid);
  const json = await shopifyGraphQLWithRetry({ store, token, query: FILE_NODE_QUERY, variables: { id: gid } });
  const node = json.data?.node;
  const url = node?.url ?? node?.image?.url;
  const name = url ? decodeURIComponent(url.split('?')[0].split('/').pop()) : '';
  cache.set(gid, name);
  return name;
}

// --- Pomocnicze: rich_text (Portable Text-owy JSON) -> płaski tekst do edycji ---

function richTextToPlain(value) {
  if (!value) return '';
  let root;
  try {
    root = JSON.parse(value);
  } catch {
    return String(value);
  }
  const textOf = (node) => {
    if (!node) return '';
    if (node.type === 'text') return node.value ?? '';
    if (Array.isArray(node.children)) return node.children.map(textOf).join('');
    return '';
  };
  const blocks = (root.children ?? []).map(textOf);
  return blocks.join('\n').trim();
}

function parseRefList(value) {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// --- Budowa arkusza dla jednej grupy (wina / spożywcze) ---

async function buildWorkbook({
  store,
  token,
  groupLabel,
  products,
  scaleAxes,
  refLabelMaps, // { cechy: Map<gid,label>, faq: ..., karty_historii: ..., polecamy_do: ... }
  productTitleByGid, // Map<gid, title> — dla warianty
  poziomSkaliByGid, // Map<gid, { skalaHandle, wartosc }>
  refListSources, // { cechy: string[], faq: [...], ... } — pełne listy do walidacji
  fileNameCache,
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'mmw export-produkty-xlsx';
  wb.created = new Date();

  // --- Kolumny arkusza "Dane" ---
  const columns = [
    { key: 'handle', header: 'Handle', width: 28, locked: true },
    { key: 'tytul', header: 'Tytuł produktu', width: 34, locked: true },
    { key: 'typ_wiersza', header: 'Typ wiersza', width: 12, locked: true },
  ];
  for (const axis of scaleAxes) {
    columns.push({ key: `skala__${axis.skalaHandle}`, header: axis.header, width: 16, locked: false, numeric13: true });
  }
  for (const field of REF_LIST_FIELDS) {
    for (let i = 1; i <= field.count; i++) {
      columns.push({ key: `${field.key}__${i}`, header: `${field.headerBase} ${i}`, width: 24, locked: false, listSource: field.key });
    }
  }
  for (let i = 1; i <= WARIANTY_COUNT; i++) {
    columns.push({ key: `warianty__${i}`, header: `Wariant ${i}`, width: 30, locked: false, listSource: 'warianty' });
  }
  for (const t of TEXT_FIELDS) {
    columns.push({ key: t.key, header: t.header, width: 40, locked: false });
  }
  columns.push({ key: 'karta_produktu', header: 'Karta produktu (nazwa pliku)', width: 28, locked: false });

  const dataSheet = wb.addWorksheet('Dane', { views: [{ state: 'frozen', ySplit: 1 }] });
  dataSheet.columns = columns.map((c) => ({ key: c.key, width: c.width }));

  const headerRow = dataSheet.getRow(1);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5F312F' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  headerRow.height = 30;

  // --- Ukryty arkusz "Listy" — źródła dropdownów (data validation po zakresie, nie literale,
  //     bo polecamy_do ma 54 pozycje — inline lista ma limit długości w XLSX). ---
  const listsSheet = wb.addWorksheet('Listy', { state: 'veryHidden' });
  const listColByKey = {};
  let listColIdx = 1;
  for (const [key, values] of Object.entries(refListSources)) {
    const colLetter = listsSheet.getColumn(listColIdx).letter;
    listsSheet.getCell(1, listColIdx).value = key;
    values.forEach((v, i) => {
      listsSheet.getCell(i + 2, listColIdx).value = v;
    });
    listColByKey[key] = { colLetter, lastRow: values.length + 1 };
    listColIdx++;
  }

  // --- Wiersze WZÓR (pierwsze, wyróżnione, zablokowane) ---
  const sampleFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3D6' } };
  let rowIndex = 2;
  const sampleProducts = products.filter((p) => SAMPLE_TITLES.includes(p.title));

  async function buildRowValues(p, isSample) {
    const values = { handle: p.handle, tytul: p.title, typ_wiersza: isSample ? 'WZÓR' : '' };

    for (const axis of scaleAxes) {
      values[`skala__${axis.skalaHandle}`] = '';
    }
    const skaleGids = parseRefList(p.mf['custom.skale']);
    for (const gid of skaleGids) {
      const info = poziomSkaliByGid.get(gid);
      if (!info) continue;
      const axis = scaleAxes.find((a) => a.skalaHandle === info.skalaHandle);
      if (axis) values[`skala__${axis.skalaHandle}`] = info.wartosc;
    }

    for (const field of REF_LIST_FIELDS) {
      const gids = parseRefList(p.mf[`custom.${field.key}`]);
      for (let i = 0; i < field.count; i++) {
        const gid = gids[i];
        values[`${field.key}__${i + 1}`] = gid ? (refLabelMaps[field.key].get(gid) ?? '') : '';
      }
    }

    const variantGids = parseRefList(p.mf['custom.warianty']);
    for (let i = 0; i < WARIANTY_COUNT; i++) {
      const gid = variantGids[i];
      values[`warianty__${i + 1}`] = gid ? (productTitleByGid.get(gid) ?? '') : '';
    }

    for (const t of TEXT_FIELDS) {
      const raw = p.mf[`custom.${t.key}`];
      values[t.key] = t.richText ? richTextToPlain(raw) : (raw ?? '');
    }

    const fileGid = p.mf['custom.karta_produktu'];
    values.karta_produktu = fileGid ? await resolveFileName({ store, token, gid: fileGid, cache: fileNameCache }) : '';

    return values;
  }

  async function writeRow(p, isSample) {
    const values = await buildRowValues(p, isSample);
    const row = dataSheet.getRow(rowIndex);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = values[c.key] ?? '';
      cell.protection = { locked: isSample ? true : Boolean(c.locked) };
      if (isSample) cell.fill = sampleFill;
      if (c.numeric13 && !isSample) {
        dataSheet.dataValidations.add(cell.address, {
          type: 'list',
          allowBlank: true,
          formulae: ['"1,2,3"'],
          showErrorMessage: true,
          errorTitle: 'Nieprawidłowa wartość',
          error: 'Dozwolone tylko: 1, 2 lub 3 (albo pusto = bez zmian).',
        });
      }
      if (c.listSource && !isSample) {
        const src = listColByKey[c.listSource];
        dataSheet.dataValidations.add(cell.address, {
          type: 'list',
          allowBlank: true,
          formulae: [`Listy!$${src.colLetter}$2:$${src.colLetter}$${src.lastRow}`],
          showErrorMessage: true,
          errorTitle: 'Nieprawidłowa wartość',
          error: 'Wybierz wartość z listy (lub zostaw puste = bez zmian).',
        });
      }
    });
    rowIndex++;
  }

  for (const p of sampleProducts) await writeRow(p, true);
  for (const p of products) {
    if (SAMPLE_TITLES.includes(p.title)) continue;
    await writeRow(p, false);
  }

  dataSheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  // --- Zakładka Instrukcja ---
  const info = wb.addWorksheet('Instrukcja');
  info.getColumn(1).width = 32;
  info.getColumn(2).width = 90;
  let r = 1;
  const writeLine = (a, b, bold = false) => {
    const row = info.getRow(r++);
    row.getCell(1).value = a;
    row.getCell(2).value = b;
    if (bold) { row.getCell(1).font = { bold: true }; row.getCell(2).font = { bold: true }; }
    row.getCell(2).alignment = { wrapText: true };
  };
  writeLine('Arkusz', `Uzupełnianie danych produktów — ${groupLabel}`, true);
  writeLine('', '');
  writeLine('PUSTA KOMÓRKA', 'Brak zmiany. Import pomija puste komórki — NIE czyści istniejącej wartości w Shopify. Żeby faktycznie wyczyścić pole, trzeba to zrobić ręcznie w adminie.', true);
  writeLine('Wiersze „WZÓR”', 'Pierwsze wiersze (żółte tło, zablokowane) to w pełni wypełnione przykłady — pokazują format oczekiwanych danych. Import ZAWSZE je pomija, niezależnie od tego, czy ktoś je edytował.', true);
  writeLine('Handle / Tytuł produktu', 'Klucz identyfikujący produkt — kolumny zablokowane, nie edytować.');
  writeLine('', '');
  writeLine('Kolumny skal sensorycznych', 'Wartość liczbowa 1–3 (dropdown). Puste = bez zmiany.', true);
  for (const axis of scaleAxes) {
    writeLine(axis.header, '1 = najniższy poziom osi, 3 = najwyższy — patrz przykładowe etykiety niżej.');
  }
  if (groupLabel === 'wina') {
    writeLine('⚠ Wygląd (białe) / Wygląd (czerwone)', 'To DWIE OSOBNE kolumny sąsiadujące ze sobą. Wypełnia się TYLKO JEDNĄ z nich, zależnie od typu wina (białe → kolumna "Wygląd (białe)", czerwone/różowe → kolumna "Wygląd (czerwone)"). Druga zostaje pusta — to nie błąd.', true);
  }
  writeLine('', '');
  writeLine('Skale — znaczenie 1/2/3 (etykiety z metaobiektów)', '', true);
  for (const axis of scaleAxes) {
    const labels = [...poziomSkaliByGid.values()]
      .filter((v) => v.skalaHandle === axis.skalaHandle)
      .sort((a, b) => a.wartosc - b.wartosc)
      .map((v) => `${v.wartosc}=${v.etykieta ?? '?'}`)
      .join(', ');
    writeLine(axis.header, labels || '(brak wpisów metaobiektu dla tej osi)');
  }
  writeLine('', '');
  writeLine('Kolumny listowe (Cecha/FAQ/Karta historii/Polecamy do/Wariant)', 'Dropdown z istniejących wpisów w Shopify. Kolejność w kolumnach 1..N nie ma znaczenia. Jeśli produkt ma mniej pozycji niż kolumn — zostają puste, to normalne.', true);
  writeLine('Wariant', 'Wybór z tytułów istniejących produktów w katalogu.');
  writeLine('Karta produktu (nazwa pliku)', 'To TYLKO nazwa pliku PDF/obrazu do orientacji — sam plik przekazujesz Marek osobno. Import mapuje nazwę → plik po stronie skryptu, nie wgrywa nic z tej kolumny automatycznie.');
  writeLine('', '');
  writeLine('Tekst SEO / Wartości odżywcze i alergeny', 'W Shopify to pole sformatowane (rich text). W arkuszu widzisz uproszczony, płaski tekst — akapity oddzielone nową linią. UWAGA: import zamienia to z powrotem na pojedynczy akapit, więc istniejące pogrubienia/nagłówki/wiele akapitów w tym polu zostaną spłaszczone przy re-imporcie edytowanej komórki.', true);

  return wb;
}

// --- Main ---

async function main() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w scripts/.env');
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  console.log('Pobieram produkty...');
  const rawProducts = await fetchAllProducts({ store, token });
  const products = rawProducts.map((p) => ({
    ...p,
    mf: Object.fromEntries(p.metafields.nodes.map((m) => [`${m.namespace}.${m.key}`, m.value])),
  }));
  console.log(`Produktów: ${products.length}`);

  const productTitleByGid = new Map(products.map((p) => [p.id, p.title]));

  console.log('Pobieram metaobiekty referencyjne (cecha_produktu, pytanie_faq, karta_historii, polecamy_do, poziom_skali, skala_sensoryczna)...');
  const [cechy, faq, kartyHistorii, polecamyDo, poziomSkali, skalaSensoryczna] = await Promise.all(
    ['cecha_produktu', 'pytanie_faq', 'karta_historii', 'polecamy_do', 'poziom_skali', 'skala_sensoryczna'].map((type) =>
      fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type })
    )
  );

  const labelField = { cecha_produktu: 'etykieta', pytanie_faq: 'pytanie', karta_historii: 'tytul', polecamy_do: 'tytul' };
  function toLabelMap(entries, type) {
    const key = labelField[type];
    return new Map(entries.map((e) => [e.id, Object.fromEntries(e.fields.map((f) => [f.key, f.value]))[key] ?? e.handle]));
  }
  const refLabelMaps = {
    cechy: toLabelMap(cechy, 'cecha_produktu'),
    faq: toLabelMap(faq, 'pytanie_faq'),
    karty_historii: toLabelMap(kartyHistorii, 'karta_historii'),
    polecamy_do: toLabelMap(polecamyDo, 'polecamy_do'),
  };
  const refListSources = {
    cechy: [...refLabelMaps.cechy.values()].sort(),
    faq: [...refLabelMaps.faq.values()].sort(),
    karty_historii: [...refLabelMaps.karty_historii.values()].sort(),
    polecamy_do: [...refLabelMaps.polecamy_do.values()].sort(),
    warianty: products.map((p) => p.title).sort(),
  };

  const skalaHandleByGid = new Map(skalaSensoryczna.map((e) => [e.id, e.handle]));
  const poziomSkaliByGid = new Map(
    poziomSkali.map((e) => {
      const f = Object.fromEntries(e.fields.map((x) => [x.key, x.value]));
      return [
        e.id,
        {
          skalaHandle: skalaHandleByGid.get(f.skala),
          wartosc: Number(f.wartosc),
          etykieta: f.nazwa,
        },
      ];
    })
  );

  const fileNameCache = new Map();

  const wineProducts = products.filter(isWine);
  const foodProducts = products.filter(isFood);
  console.log(`Wina: ${wineProducts.length}   Spożywcze: ${foodProducts.length}`);

  console.log('Buduję arkusz: wina...');
  const wineWb = await buildWorkbook({
    store,
    token,
    groupLabel: 'wina',
    products: wineProducts,
    scaleAxes: WINE_SCALE_AXES,
    refLabelMaps,
    productTitleByGid,
    poziomSkaliByGid,
    refListSources,
    fileNameCache,
  });
  const winePath = path.join(OUT_DIR, 'produkty-wina.xlsx');
  await wineWb.xlsx.writeFile(winePath);
  console.log(`Zapisano: ${winePath}`);

  console.log('Buduję arkusz: spożywcze...');
  const foodWb = await buildWorkbook({
    store,
    token,
    groupLabel: 'spożywcze',
    products: foodProducts,
    scaleAxes: FOOD_SCALE_AXES,
    refLabelMaps,
    productTitleByGid,
    poziomSkaliByGid,
    refListSources,
    fileNameCache,
  });
  const foodPath = path.join(OUT_DIR, 'produkty-spozywcze.xlsx');
  await foodWb.xlsx.writeFile(foodPath);
  console.log(`Zapisano: ${foodPath}`);
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
