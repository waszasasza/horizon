#!/usr/bin/env node
// Import danych produktów spożywczych (scripts/mmw-spozywcze-import.json, 40 produktów)
// przez Admin GraphQL API. Idempotentny — metaobjectUpsert po handle, metafieldsSet
// tylko dla pól niepustych w pliku (puste = brak zmiany, nie czyszczenie).
//
// ZAKRES (świadomie pominięte, patrz CLAUDE.md-style decyzja w rozmowie):
// pole "polecamy_do" NIE jest zapisywane na produktach spożywczych i żaden z 53
// brakujących metaobiektów "polecamy_do" NIE jest tworzony — ta sekcja istnieje
// wyłącznie na produktach winiarskich. Pole zostaje w pliku JSON (dane na przyszłość),
// tylko pomijane przy zapisie. Każde pominięcie logowane jawnie, nie po cichu.
//
// Kolejność faz (produkty referują metaobiekty, więc metaobiekty muszą istnieć pierwsze):
//   1) metaobiekty pytanie_faq (tylko brakujące, ze wszystkich 108)
//   2) metaobiekty cecha_produktu + karta_historii (tylko brakujące)
//   3) metafieldy produktów (w tym referencje do 1+2, custom.warianty, custom.skale)
//
// Użycie:
//   node import-spozywcze.mjs                 (dry-run, domyślnie, nic nie wysyła)
//   node import-spozywcze.mjs --commit         (realny import)

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { shopifyGraphQLWithRetry, sleep } from './lib/shopify-graphql.mjs';
import { fetchAllMetaobjects } from './lib/fetch-metaobjects.mjs';

dotenv.config();

const store = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ADMIN_TOKEN;

const RATE_LIMIT_DELAY_MS = 550;

// --- Slugifikacja PL -> handle ASCII (a-z0-9-), zgodna z istniejącymi handles w Shopify ---
const PL_MAP = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
};
function slugify(text) {
  return (text ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => PL_MAP[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalize(s) {
  return (s ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
}

const UPSERT_METAOBJECT_MUTATION = /* GraphQL */ `
  mutation MmwMetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle type }
      userErrors { field message code }
    }
  }
`;

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation MmwMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace ownerType }
      userErrors { field message code }
    }
  }
`;

async function upsertMetaobject({ type, handle, fields }) {
  const json = await shopifyGraphQLWithRetry({
    store,
    token,
    query: UPSERT_METAOBJECT_MUTATION,
    variables: { handle: { type, handle }, metaobject: { fields } },
  });
  if (json.errors) return { ok: false, errors: json.errors.map((e) => e.message) };
  const userErrors = json.data?.metaobjectUpsert?.userErrors ?? [];
  if (userErrors.length > 0) return { ok: false, errors: userErrors.map((e) => `${e.field ?? ''} ${e.message}`.trim()) };
  return { ok: true, metaobject: json.data.metaobjectUpsert.metaobject };
}

async function setProductMetafields({ productId, metafields }) {
  const variables = {
    metafields: metafields.map((m) => ({
      ownerId: productId,
      namespace: 'custom',
      key: m.key,
      type: m.type,
      value: m.value,
    })),
  };
  const json = await shopifyGraphQLWithRetry({ store, token, query: METAFIELDS_SET_MUTATION, variables });
  if (json.errors) return { ok: false, errors: json.errors.map((e) => e.message) };
  const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) return { ok: false, errors: userErrors.map((e) => `${e.field ?? ''} ${e.message}`.trim()) };
  return { ok: true };
}

async function fetchAllProductsByHandle() {
  const QUERY = /* GraphQL */ `
    query MmwProducts($cursor: String) {
      products(first: 100, after: $cursor) {
        nodes { id handle title }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const map = new Map();
  let cursor = null;
  while (true) {
    const json = await shopifyGraphQLWithRetry({ store, token, query: QUERY, variables: { cursor } });
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    for (const p of json.data.products.nodes) map.set(p.handle, p);
    if (!json.data.products.pageInfo.hasNextPage) break;
    cursor = json.data.products.pageInfo.endCursor;
  }
  return map;
}

function parseArgs(argv) {
  const args = { dryRun: true };
  for (const a of argv) {
    if (a === '--commit') args.dryRun = false;
    if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w scripts/.env');
    process.exit(1);
  }

  const importData = JSON.parse(await readFile('mmw-spozywcze-import.json', 'utf8'));
  const faqData = JSON.parse(await readFile('mmw-faq-metaobiekty.json', 'utf8'));

  console.log(args.dryRun ? '=== TRYB: DRY-RUN (nic nie zostanie wysłane) ===\n' : '=== TRYB: COMMIT (realny zapis) ===\n');

  const log = { utworzone: [], zaktualizowane: [], pominiete: [], bledy: [] };

  // ============================================================
  // Stan bieżący — pobrany raz, żeby dopasowywać/rozstrzygać referencje.
  // ============================================================
  console.log('Pobieram bieżący stan metaobiektów i produktów...\n');
  const [cechyExisting, kartyExisting, faqExisting, poziomySkali, productsByHandle] = await Promise.all([
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'cecha_produktu' }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'karta_historii' }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'pytanie_faq' }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'poziom_skali' }),
    fetchAllProductsByHandle(),
  ]);

  // handle poziom_skali = {os}-{wartosc}, np. "slodkosc-2" — już potwierdzone w Kroku 1,
  // istnieją wszystkie 12 (4 osie x 3 poziomy), nic do utworzenia.
  const poziomByHandle = new Map(poziomySkali.map((p) => [p.handle, p]));

  // --- cecha_produktu: mapa znormalizowana etykieta -> {handle, gid} ---
  const cechyByNorm = new Map();
  for (const c of cechyExisting) {
    const etykieta = c.fields.find((f) => f.key === 'etykieta')?.value;
    if (etykieta) cechyByNorm.set(normalize(etykieta), { handle: c.handle, id: c.id });
  }

  // --- karta_historii: mapa znormalizowany tytul -> {handle, gid} ---
  const kartyByNorm = new Map();
  for (const k of kartyExisting) {
    const tytul = k.fields.find((f) => f.key === 'tytul')?.value;
    if (tytul) kartyByNorm.set(normalize(tytul), { handle: k.handle, id: k.id });
  }

  // --- pytanie_faq: mapa handle -> {handle, gid} (JSON już daje docelowe handles) ---
  const faqByHandle = new Map(faqExisting.map((f) => [f.handle, f]));

  // ============================================================
  // FAZA 1 — pytanie_faq (tylko brakujące ze 108)
  // ============================================================
  console.log('=== FAZA 1: metaobiekty pytanie_faq ===\n');
  const faqToCreate = faqData.filter((f) => !faqByHandle.has(f.handle));
  console.log(`Ze 108: ${faqData.length - faqToCreate.length} już istnieje (pomijane), ${faqToCreate.length} do utworzenia.\n`);

  const faqGidByHandle = new Map(faqExisting.map((f) => [f.handle, f.id]));
  for (const f of faqToCreate) {
    const fields = [
      { key: 'pytanie', value: f.pytanie },
      { key: 'odpowiedz', value: f.odpowiedz.plain },
    ];
    if (args.dryRun) {
      console.log(`  UTWORZYĆ  pytanie_faq:${f.handle}  pytanie="${f.pytanie}"`);
      log.utworzone.push({ typ: 'pytanie_faq', handle: f.handle });
      continue;
    }
    const result = await upsertMetaobject({ type: 'pytanie_faq', handle: f.handle, fields });
    if (result.ok) {
      faqGidByHandle.set(f.handle, result.metaobject.id);
      log.utworzone.push({ typ: 'pytanie_faq', handle: f.handle });
      console.log(`  OK  ${f.handle}`);
    } else {
      log.bledy.push({ typ: 'pytanie_faq', handle: f.handle, errors: result.errors });
      console.log(`  BŁĄD  ${f.handle}: ${result.errors.join('; ')}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // ============================================================
  // FAZA 2a — cecha_produktu (tylko brakujące z 7; polecamy_do POMINIĘTE CAŁKOWICIE)
  // ============================================================
  console.log('\n=== FAZA 2a: metaobiekty cecha_produktu ===\n');
  const allCechyWanted = [...new Set(importData.flatMap((p) => p.cechy ?? []))];
  const cechyToCreate = allCechyWanted.filter((c) => !cechyByNorm.has(normalize(c)));
  console.log(`Z ${allCechyWanted.length} unikalnych wartości "cechy" w pliku: ${allCechyWanted.length - cechyToCreate.length} już istnieje, ${cechyToCreate.length} do utworzenia.\n`);

  for (const label of cechyToCreate) {
    const handle = slugify(label);
    const fields = [{ key: 'etykieta', value: label }];
    if (args.dryRun) {
      console.log(`  UTWORZYĆ  cecha_produktu:${handle}  etykieta="${label}"  (ikona/kolor_tla: puste, do ręcznego uzupełnienia)`);
      log.utworzone.push({ typ: 'cecha_produktu', handle });
      cechyByNorm.set(normalize(label), { handle, id: null }); // placeholder do fazy 3 (dry-run)
      continue;
    }
    const result = await upsertMetaobject({ type: 'cecha_produktu', handle, fields });
    if (result.ok) {
      cechyByNorm.set(normalize(label), { handle, id: result.metaobject.id });
      log.utworzone.push({ typ: 'cecha_produktu', handle });
      console.log(`  OK  ${handle}`);
    } else {
      log.bledy.push({ typ: 'cecha_produktu', handle, errors: result.errors });
      console.log(`  BŁĄD  ${handle}: ${result.errors.join('; ')}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // ============================================================
  // FAZA 2b — karta_historii (tylko brakujące z 8)
  // Brak danych "etykieta"/"tresc"/"obraz" w pliku spożywczym — tylko tytuł.
  // Handle ze slugifikacji TYTUŁU (nie etykiety, jak w istniejących winiarskich —
  // dla tych nowych kart nie mamy osobnej etykiety kategorii).
  // ============================================================
  console.log('\n=== FAZA 2b: metaobiekty karta_historii ===\n');
  const allKartyWanted = [...new Set(importData.flatMap((p) => p.karty_historii ?? []))];
  const kartyToCreate = allKartyWanted.filter((k) => !kartyByNorm.has(normalize(k)));
  console.log(`Z ${allKartyWanted.length} unikalnych wartości "karty_historii" w pliku: ${allKartyWanted.length - kartyToCreate.length} już istnieje, ${kartyToCreate.length} do utworzenia.\n`);

  for (const tytul of kartyToCreate) {
    const handle = slugify(tytul);
    const fields = [{ key: 'tytul', value: tytul }];
    if (args.dryRun) {
      console.log(`  UTWORZYĆ  karta_historii:${handle}  tytul="${tytul}"  (etykieta/tresc/obraz: puste, do ręcznego uzupełnienia)`);
      log.utworzone.push({ typ: 'karta_historii', handle });
      kartyByNorm.set(normalize(tytul), { handle, id: null });
      continue;
    }
    const result = await upsertMetaobject({ type: 'karta_historii', handle, fields });
    if (result.ok) {
      kartyByNorm.set(normalize(tytul), { handle, id: result.metaobject.id });
      log.utworzone.push({ typ: 'karta_historii', handle });
      console.log(`  OK  ${handle}`);
    } else {
      log.bledy.push({ typ: 'karta_historii', handle, errors: result.errors });
      console.log(`  BŁĄD  ${handle}: ${result.errors.join('; ')}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // ============================================================
  // FAZA 3 — metafieldy produktów
  // ============================================================
  console.log('\n=== FAZA 3: metafieldy 40 produktów ===\n');

  for (const item of importData) {
    console.log(`--- ${item.handle} ---`);
    const product = productsByHandle.get(item.handle);
    if (!product) {
      log.bledy.push({ typ: 'produkt', handle: item.handle, errors: ['Produkt nie istnieje (nieoczekiwane — Krok 1 potwierdził istnienie)'] });
      console.log('  BŁĄD: produkt nie istnieje w katalogu, pomijam.');
      continue;
    }

    const metafields = [];
    const pominieteTegoProduktu = [];

    // --- polecamy_do: ZAWSZE pomijane, jawnie logowane ---
    if (item.polecamy_do && item.polecamy_do.length > 0) {
      pominieteTegoProduktu.push(`custom.polecamy_do — POMINIĘTE (poza zakresem: sekcja "Polecamy do" tylko na winie; ${item.polecamy_do.length} wartości w pliku zignorowane)`);
    }

    // --- teksty proste (puste = brak zmiany) ---
    const textFieldMap = {
      przechowywanie: 'przechowywanie',
      skad_pochodzi: 'skad_pochodzi',
      opis_karty: 'opis_karty',
      dominujace_nuty: 'dominujace_nuty',
    };
    for (const [jsonKey, metaKey] of Object.entries(textFieldMap)) {
      const val = item[jsonKey];
      if (val != null && String(val).trim() !== '') {
        metafields.push({ key: metaKey, type: 'multi_line_text_field', value: val });
      } else {
        pominieteTegoProduktu.push(`custom.${metaKey} — puste w pliku, brak zmiany`);
      }
    }

    // --- rich text (custom.wartosci_odzywcze_i_alergeny, custom.tekst_seo) ---
    const richTextFieldMap = {
      wartosci_odzywcze_alergeny: 'wartosci_odzywcze_i_alergeny',
      tekst_seo: 'tekst_seo',
    };
    for (const [jsonKey, metaKey] of Object.entries(richTextFieldMap)) {
      const val = item[jsonKey];
      if (val?.rich_text) {
        metafields.push({ key: metaKey, type: 'rich_text_field', value: JSON.stringify(val.rich_text) });
      } else {
        pominieteTegoProduktu.push(`custom.${metaKey} — puste w pliku, brak zmiany`);
      }
    }

    // --- custom.skale (list.metaobject_reference -> poziom_skali) ---
    if (item.skale_sensoryczne && Object.keys(item.skale_sensoryczne).length > 0) {
      const gids = [];
      const missing = [];
      for (const [os, wartosc] of Object.entries(item.skale_sensoryczne)) {
        const handle = `${os}-${wartosc}`;
        const poziom = poziomByHandle.get(handle);
        if (poziom) gids.push(poziom.id);
        else missing.push(handle);
      }
      if (missing.length > 0) {
        log.bledy.push({ typ: 'produkt', handle: item.handle, errors: [`custom.skale: brak poziom_skali dla ${missing.join(', ')}`] });
      }
      if (gids.length > 0) metafields.push({ key: 'skale', type: 'list.metaobject_reference', value: JSON.stringify(gids) });
    } else {
      pominieteTegoProduktu.push('custom.skale — puste w pliku, brak zmiany');
    }

    // --- custom.cechy (list.metaobject_reference -> cecha_produktu) ---
    if (item.cechy && item.cechy.length > 0) {
      const gids = [];
      const missing = [];
      for (const label of item.cechy) {
        const found = cechyByNorm.get(normalize(label));
        if (found?.id) gids.push(found.id);
        else if (found && args.dryRun) gids.push(`<GID cecha_produktu:${found.handle} po utworzeniu w Fazie 2a>`);
        else missing.push(label);
      }
      if (missing.length > 0) log.bledy.push({ typ: 'produkt', handle: item.handle, errors: [`custom.cechy: brak dopasowania dla ${missing.join(', ')}`] });
      if (gids.length > 0) metafields.push({ key: 'cechy', type: 'list.metaobject_reference', value: args.dryRun ? JSON.stringify(gids) : JSON.stringify(gids) });
    } else {
      pominieteTegoProduktu.push('custom.cechy — puste w pliku, brak zmiany');
    }

    // --- custom.karty_historii (list.metaobject_reference -> karta_historii) ---
    if (item.karty_historii && item.karty_historii.length > 0) {
      const gids = [];
      const missing = [];
      for (const tytul of item.karty_historii) {
        const found = kartyByNorm.get(normalize(tytul));
        if (found?.id) gids.push(found.id);
        else if (found && args.dryRun) gids.push(`<GID karta_historii:${found.handle} po utworzeniu w Fazie 2b>`);
        else missing.push(tytul);
      }
      if (missing.length > 0) log.bledy.push({ typ: 'produkt', handle: item.handle, errors: [`custom.karty_historii: brak dopasowania dla ${missing.join(', ')}`] });
      if (gids.length > 0) metafields.push({ key: 'karty_historii', type: 'list.metaobject_reference', value: JSON.stringify(gids) });
    } else {
      pominieteTegoProduktu.push('custom.karty_historii — puste w pliku, brak zmiany');
    }

    // --- custom.faq (list.metaobject_reference -> pytanie_faq), JSON już daje docelowe handles ---
    if (item.faq_handle && item.faq_handle.length > 0) {
      const gids = [];
      const missing = [];
      for (const h of item.faq_handle) {
        const gid = faqGidByHandle.get(h);
        if (gid) gids.push(gid);
        else if (args.dryRun && faqToCreate.some((f) => f.handle === h)) gids.push(`<GID pytanie_faq:${h} po utworzeniu w Fazie 1>`);
        else missing.push(h);
      }
      if (missing.length > 0) log.bledy.push({ typ: 'produkt', handle: item.handle, errors: [`custom.faq: brak handle ${missing.join(', ')}`] });
      if (gids.length > 0) metafields.push({ key: 'faq', type: 'list.metaobject_reference', value: JSON.stringify(gids) });
    } else {
      pominieteTegoProduktu.push('custom.faq — puste w pliku, brak zmiany');
    }

    // --- custom.warianty (list.product_reference), warianty_handle -> istniejące produkty ---
    if (item.warianty_handle && item.warianty_handle.length > 0) {
      const gids = [];
      const missing = [];
      for (const h of item.warianty_handle) {
        const p = productsByHandle.get(h);
        if (p) gids.push(p.id);
        else missing.push(h);
      }
      if (missing.length > 0) log.bledy.push({ typ: 'produkt', handle: item.handle, errors: [`custom.warianty: brak produktu ${missing.join(', ')}`] });
      if (gids.length > 0) metafields.push({ key: 'warianty', type: 'list.product_reference', value: JSON.stringify(gids) });
    } else {
      pominieteTegoProduktu.push('custom.warianty — puste w pliku, brak zmiany');
    }

    // --- karta_produktu_plik: zawsze null w tej partii ---
    if (!item.karta_produktu_plik) {
      pominieteTegoProduktu.push('custom.karta_produktu — puste w pliku (plik), brak zmiany');
    }

    for (const p of pominieteTegoProduktu) console.log(`  POMIŃ  ${p}`);
    log.pominiete.push({ handle: item.handle, powody: pominieteTegoProduktu });

    if (args.dryRun) {
      console.log(`  ZAPISAĆ (${metafields.length} pól): ${metafields.map((m) => m.key).join(', ')}`);
      log.zaktualizowane.push({ handle: item.handle, pola: metafields.map((m) => m.key) });
      continue;
    }

    if (metafields.length === 0) {
      console.log('  Brak pól do zapisania.');
      continue;
    }

    const result = await setProductMetafields({ productId: product.id, metafields });
    if (result.ok) {
      log.zaktualizowane.push({ handle: item.handle, pola: metafields.map((m) => m.key) });
      console.log(`  OK  zapisano ${metafields.length} pól: ${metafields.map((m) => m.key).join(', ')}`);
    } else {
      log.bledy.push({ typ: 'produkt-metafields', handle: item.handle, errors: result.errors });
      console.log(`  BŁĄD: ${result.errors.join('; ')}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // ============================================================
  // Podsumowanie + log do pliku
  // ============================================================
  console.log('\n=== PODSUMOWANIE ===');
  console.log(`Utworzone metaobiekty: ${log.utworzone.length}`);
  console.log(`Zaktualizowane produkty: ${log.zaktualizowane.length}`);
  console.log(`Błędy: ${log.bledy.length}`);
  if (args.dryRun) console.log('\nAby wykonać realny zapis, uruchom z flagą --commit.');

  const logPath = path.resolve(`import-spozywcze-log-${args.dryRun ? 'dryrun' : 'commit'}-${Date.now()}.json`);
  await writeFile(logPath, JSON.stringify({ zapisano: new Date().toISOString(), tryb: args.dryRun ? 'dry-run' : 'commit', ...log }, null, 2), 'utf8');
  console.log(`\nLog zapisany do ${logPath}`);
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
