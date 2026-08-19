#!/usr/bin/env node
// Krok 1 (rekonesans, READ-ONLY) dla importu danych produktów spożywczych.
// Nic nie zapisuje — tylko odczyt: definicje metapól produktu, istniejące metaobiekty
// (cecha_produktu, karta_historii, polecamy_do, pytanie_faq, poziom_skali,
// skala_sensoryczna) i istnienie 40 handle'i produktów z mmw-spozywcze-import.json.
//
// Użycie: node inspect-spozywcze-import.mjs

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import dotenv from 'dotenv';
import { shopifyGraphQLWithRetry } from './lib/shopify-graphql.mjs';
import { fetchAllMetaobjects } from './lib/fetch-metaobjects.mjs';

dotenv.config();

const store = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ADMIN_TOKEN;
if (!store || !token) {
  console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w scripts/.env');
  process.exit(1);
}

const PRODUCT_METAFIELD_DEFS_QUERY = /* GraphQL */ `
  query MmwProductMetafieldDefs($cursor: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 100, after: $cursor) {
      nodes {
        namespace
        key
        name
        type {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function fetchAllProductMetafieldDefs() {
  let cursor = null;
  const all = [];
  while (true) {
    const json = await shopifyGraphQLWithRetry({
      store,
      token,
      query: PRODUCT_METAFIELD_DEFS_QUERY,
      variables: { cursor },
    });
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    all.push(...json.data.metafieldDefinitions.nodes);
    if (!json.data.metafieldDefinitions.pageInfo.hasNextPage) break;
    cursor = json.data.metafieldDefinitions.pageInfo.endCursor;
  }
  return all;
}

async function checkHandlesExist(handles) {
  // Batch po 20 aliasów na zapytanie — bezpieczne pod kątem query cost.
  const results = new Map();
  const chunkSize = 20;
  for (let i = 0; i < handles.length; i += chunkSize) {
    const chunk = handles.slice(i, i + chunkSize);
    const fields = chunk
      .map((h, idx) => `h${i + idx}: productByHandle(handle: ${JSON.stringify(h)}) { id handle title }`)
      .join('\n');
    const query = `query MmwCheckHandles { ${fields} }`;
    const json = await shopifyGraphQLWithRetry({ store, token, query, variables: {} });
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    chunk.forEach((h, idx) => {
      results.set(h, json.data[`h${i + idx}`]);
    });
  }
  return results;
}

function normalize(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const importData = JSON.parse(await readFile('mmw-spozywcze-import.json', 'utf8'));
  const slowniki = JSON.parse(await readFile('mmw-spozywcze-slowniki.json', 'utf8'));
  const faqData = JSON.parse(await readFile('mmw-faq-metaobiekty.json', 'utf8'));

  console.log('========================================');
  console.log('1) DEFINICJE METAPÓL PRODUKTU (namespace: custom)');
  console.log('========================================\n');
  const defs = await fetchAllProductMetafieldDefs();
  const customDefs = defs.filter((d) => d.namespace === 'custom');
  for (const d of customDefs.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`  custom.${d.key}  (${d.type.name})  — "${d.name}"`);
  }
  console.log(`\n  Razem: ${customDefs.length} definicji w namespace "custom".`);

  console.log('\n========================================');
  console.log('2) METAOBIEKTY: skala_sensoryczna + poziom_skali (istniejące)');
  console.log('========================================\n');
  const [skale, poziomy] = await Promise.all([
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'skala_sensoryczna' }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'poziom_skali' }),
  ]);
  console.log(`skala_sensoryczna (${skale.length}):`);
  for (const s of skale) {
    const nazwa = s.fields.find((f) => f.key === 'nazwa')?.value;
    console.log(`  ${s.handle} — nazwa="${nazwa}"`);
  }
  console.log(`\npoziom_skali (${poziomy.length}):`);
  for (const p of poziomy) {
    const skalaRef = p.fields.find((f) => f.key === 'skala')?.value;
    const wartosc = p.fields.find((f) => f.key === 'wartosc')?.value;
    const nazwa = p.fields.find((f) => f.key === 'nazwa')?.value;
    console.log(`  ${p.handle} — skala=${skalaRef} wartosc=${wartosc} nazwa="${nazwa}"`);
  }

  console.log('\n========================================');
  console.log('3) METAOBIEKTY: cecha_produktu, karta_historii, polecamy_do');
  console.log('========================================\n');
  const [cechy, kartyHist, polecamyDo] = await Promise.all([
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'cecha_produktu' }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'karta_historii' }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'polecamy_do' }),
  ]);

  function compareList(label, existingMetaobjects, wantedList, labelFieldCandidates) {
    console.log(`\n--- ${label} ---`);
    console.log(`Istniejące w Shopify (${existingMetaobjects.length}):`);
    const existingByNorm = new Map();
    for (const m of existingMetaobjects) {
      let labelValue = null;
      for (const cand of labelFieldCandidates) {
        const f = m.fields.find((f) => f.key === cand);
        if (f) { labelValue = f.value; break; }
      }
      labelValue = labelValue ?? m.displayName ?? m.handle;
      console.log(`  ${m.handle} — fields: ${m.fields.map((f) => `${f.key}=${JSON.stringify(f.value)}`).join(', ')}`);
      existingByNorm.set(normalize(labelValue), { handle: m.handle, label: labelValue });
    }

    const wanted = wantedList.map((w) => (typeof w === 'string' ? w : w.wartosc));
    const istniejace = [];
    const doUtworzenia = [];
    const bliskieNieidentyczne = [];

    for (const w of wanted) {
      const norm = normalize(w);
      if (existingByNorm.has(norm)) {
        istniejace.push({ wanted: w, matched: existingByNorm.get(norm) });
        continue;
      }
      // szukaj "bliskich" (jedna zawiera drugą, po normalizacji)
      const close = [...existingByNorm.values()].filter(
        (e) => normalize(e.label).includes(norm) || norm.includes(normalize(e.label))
      );
      if (close.length > 0) {
        bliskieNieidentyczne.push({ wanted: w, close });
      } else {
        doUtworzenia.push(w);
      }
    }

    console.log(`\nIstniejące — dokładne dopasowanie (${istniejace.length}):`);
    for (const i of istniejace) console.log(`  "${i.wanted}" == ${i.matched.handle}`);

    console.log(`\nDo utworzenia — brak jakiegokolwiek dopasowania (${doUtworzenia.length}):`);
    for (const d of doUtworzenia) console.log(`  "${d}"`);

    console.log(`\nBLISKIE ale NIEIDENTYCZNE — wymaga decyzji (${bliskieNieidentyczne.length}):`);
    for (const b of bliskieNieidentyczne) {
      console.log(`  "${b.wanted}"  ~ ${b.close.map((c) => `${c.handle} ("${c.label}")`).join(', ')}`);
    }

    return { istniejace, doUtworzenia, bliskieNieidentyczne };
  }

  compareList('cechy (7)', cechy, slowniki.slowniki.cechy, ['label', 'nazwa']);
  compareList('karty_historii (8)', kartyHist, slowniki.slowniki.karty_historii, ['tytul', 'nazwa', 'label']);
  compareList('polecamy_do (59)', polecamyDo, slowniki.slowniki.polecamy_do, ['nazwa', 'label', 'tytul']);

  console.log('\n========================================');
  console.log('4) FAQ — struktura metaobiektu pytanie_faq + ile ze 108 już istnieje');
  console.log('========================================\n');
  const faqMetaobjects = await fetchAllMetaobjects({ store, token, graphql: shopifyGraphQLWithRetry, type: 'pytanie_faq' });
  console.log(`Istniejących pytanie_faq: ${faqMetaobjects.length}`);
  if (faqMetaobjects.length > 0) {
    console.log(`Pola pierwszego wpisu (${faqMetaobjects[0].handle}):`);
    for (const f of faqMetaobjects[0].fields) {
      console.log(`  ${f.key}  (${f.type})  = ${JSON.stringify(f.value).slice(0, 100)}`);
    }
  }
  const existingFaqHandles = new Set(faqMetaobjects.map((f) => f.handle));
  const wantedFaqHandles = faqData.map((f) => f.handle);
  const faqExisting = wantedFaqHandles.filter((h) => existingFaqHandles.has(h));
  const faqMissing = wantedFaqHandles.filter((h) => !existingFaqHandles.has(h));
  console.log(`\nZe 108 z pliku: ${faqExisting.length} już istnieje po handle, ${faqMissing.length} brakuje.`);
  if (faqMissing.length > 0 && faqMissing.length <= 20) {
    console.log('Brakujące handles:');
    for (const h of faqMissing) console.log(`  ${h}`);
  }

  console.log('\n========================================');
  console.log('5) ISTNIENIE 40 HANDLE\'I PRODUKTÓW');
  console.log('========================================\n');
  const allHandles = [...new Set(importData.map((p) => p.handle))];
  const handleResults = await checkHandlesExist(allHandles);
  const missing = [];
  for (const h of allHandles) {
    const p = handleResults.get(h);
    if (!p) {
      missing.push(h);
      console.log(`  BRAK  ${h}`);
    } else {
      console.log(`  OK    ${h}  -> ${p.title}`);
    }
  }
  console.log(`\nRazem: ${allHandles.length - missing.length}/${allHandles.length} istnieje. Brakuje: ${missing.length}.`);
}

main().catch((err) => {
  console.error('Błąd:', err);
  process.exit(1);
});
