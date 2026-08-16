#!/usr/bin/env node
// Krok 1 — introspekcja (READ-ONLY, żadnych mutacji, żadnego eksportu pliku).
// 1) Wszystkie definicje metafieldów produktowych + ile produktów ma je wypełnione/puste.
// 2) Rozkład productType / tags / collections — do ustalenia reguły wino vs spożywcze.
//
// Użycie: node inspect-produkty.mjs

import process from 'node:process';
import dotenv from 'dotenv';
import { shopifyGraphQLWithRetry } from './lib/shopify-graphql.mjs';

dotenv.config();

const DEFINITIONS_QUERY = /* GraphQL */ `
  query MmwProductMetafieldDefs($cursor: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 100, after: $cursor) {
      nodes {
        namespace
        key
        name
        description
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

const PRODUCTS_QUERY = /* GraphQL */ `
  query MmwProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      nodes {
        id
        title
        handle
        productType
        tags
        collections(first: 10) {
          nodes {
            title
            handle
          }
        }
        metafields(first: 100) {
          nodes {
            namespace
            key
            type
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function fetchAllDefinitions({ store, token }) {
  let cursor = null;
  const all = [];
  while (true) {
    const json = await shopifyGraphQLWithRetry({ store, token, query: DEFINITIONS_QUERY, variables: { cursor } });
    if (json.errors) throw new Error(`metafieldDefinitions: ${JSON.stringify(json.errors)}`);
    all.push(...json.data.metafieldDefinitions.nodes);
    if (!json.data.metafieldDefinitions.pageInfo.hasNextPage) break;
    cursor = json.data.metafieldDefinitions.pageInfo.endCursor;
  }
  return all;
}

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

async function main() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w scripts/.env');
    process.exit(1);
  }

  console.log('Pobieram definicje metafieldów produktowych...');
  const definitions = await fetchAllDefinitions({ store, token });
  console.log(`Definicji: ${definitions.length}\n`);

  console.log('Pobieram wszystkie produkty (metafields/tags/productType/collections)...');
  const products = await fetchAllProducts({ store, token });
  console.log(`Produktów: ${products.length}\n`);

  // --- Część 1: definicje + wypełnienie ---
  console.log('=== 1. Definicje metafieldów produktowych (namespace.key : typ : nazwa) ===\n');
  const fillCounts = new Map(); // "namespace.key" -> count filled

  for (const p of products) {
    for (const mf of p.metafields.nodes) {
      const k = `${mf.namespace}.${mf.key}`;
      fillCounts.set(k, (fillCounts.get(k) ?? 0) + 1);
    }
  }

  const rows1 = definitions
    .map((d) => {
      const k = `${d.namespace}.${d.key}`;
      const filled = fillCounts.get(k) ?? 0;
      return { k, type: d.type.name, name: d.name, description: d.description ?? '', filled, empty: products.length - filled };
    })
    .sort((a, b) => a.k.localeCompare(b.k));

  for (const r of rows1) {
    console.log(`${r.k}  [${r.type}]  "${r.name}"`);
    if (r.description) console.log(`    opis: ${r.description}`);
    console.log(`    wypełnione: ${r.filled}/${products.length}   puste: ${r.empty}/${products.length}`);
  }

  // Metafieldy WYSTĘPUJĄCE na produktach, których NIE MA w definicjach (np. app-owe, legacy)
  const definedKeys = new Set(definitions.map((d) => `${d.namespace}.${d.key}`));
  const undefinedKeys = new Set();
  for (const p of products) {
    for (const mf of p.metafields.nodes) {
      const k = `${mf.namespace}.${mf.key}`;
      if (!definedKeys.has(k)) undefinedKeys.add(k);
    }
  }
  if (undefinedKeys.size > 0) {
    console.log('\n--- Metafieldy obecne na produktach, ale BEZ definicji (namespace.key) ---');
    for (const k of [...undefinedKeys].sort()) {
      console.log(`  ${k}  (wypełnione: ${fillCounts.get(k)}/${products.length})`);
    }
  }

  // --- Część 2: wino vs spożywcze ---
  console.log('\n\n=== 2. Rozkład productType ===\n');
  const byType = new Map();
  for (const p of products) {
    const t = p.productType || '(puste)';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(p.title);
  }
  for (const [t, titles] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${t}: ${titles.length}`);
    for (const title of titles.slice(0, 5)) console.log(`    - ${title}`);
    if (titles.length > 5) console.log(`    ... (+${titles.length - 5} więcej)`);
  }

  console.log('\n=== Rozkład kolekcji (top 20) ===\n');
  const byCollection = new Map();
  for (const p of products) {
    for (const c of p.collections.nodes) {
      if (!byCollection.has(c.title)) byCollection.set(c.title, 0);
      byCollection.set(c.title, byCollection.get(c.title) + 1);
    }
  }
  for (const [c, count] of [...byCollection.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${c}: ${count}`);
  }

  console.log('\n=== Rozkład tagów (top 30) ===\n');
  const byTag = new Map();
  for (const p of products) {
    for (const t of p.tags) {
      if (!byTag.has(t)) byTag.set(t, 0);
      byTag.set(t, byTag.get(t) + 1);
    }
  }
  for (const [t, count] of [...byTag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`${t}: ${count}`);
  }

  // Zrzut surowy do pliku tymczasowego, żeby móc doszczegółowić bez ponownego zapytania.
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    'inspect-produkty-raw.json',
    JSON.stringify({ zapisano: new Date().toISOString(), definitions, products }, null, 2),
    'utf8'
  );
  console.log('\nSurowy zrzut zapisany do scripts/inspect-produkty-raw.json (do dalszej analizy, nie do commitu).');
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
