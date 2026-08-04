#!/usr/bin/env node
// Krok 0 — introspekcja (READ-ONLY, żadnych mutacji).
// Pobiera definicje metaobiektów skala_sensoryczna/poziom_skali + istniejące wpisy
// + definicje metafieldów product.custom.skale i product.custom.karta_produktu.
//
// Użycie: node inspect-sensoryka.mjs

import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

const API_VERSION = '2026-07';

async function shopifyGraphQL({ store, token, query, variables }) {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

const DEFINITION_QUERY = /* GraphQL */ `
  query MmwDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      name
      type
      fieldDefinitions {
        key
        name
        type {
          name
        }
        required
      }
    }
  }
`;

const ENTRIES_QUERY = /* GraphQL */ `
  query MmwEntriesByType($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 50, after: $cursor) {
      nodes {
        id
        handle
        displayName
        fields {
          key
          value
          type
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const METAFIELD_DEF_QUERY = /* GraphQL */ `
  query MmwProductMetafieldDef($namespace: String!, $key: String!) {
    metafieldDefinitions(ownerType: PRODUCT, namespace: $namespace, key: $key, first: 5) {
      nodes {
        id
        namespace
        key
        name
        type {
          name
        }
        validations {
          name
          value
        }
      }
    }
  }
`;

async function fetchAllEntries({ store, token, type }) {
  let cursor = null;
  const all = [];
  while (true) {
    const data = await shopifyGraphQL({ store, token, query: ENTRIES_QUERY, variables: { type, cursor } });
    all.push(...data.metaobjects.nodes);
    if (!data.metaobjects.pageInfo.hasNextPage) break;
    cursor = data.metaobjects.pageInfo.endCursor;
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

  console.log(`=== Definicje metaobiektów (${API_VERSION}) ===\n`);

  for (const type of ['skala_sensoryczna', 'poziom_skali']) {
    const data = await shopifyGraphQL({ store, token, query: DEFINITION_QUERY, variables: { type } });
    const def = data.metaobjectDefinitionByType;
    if (!def) {
      console.log(`[BRAK] Definicja "${type}" NIE ISTNIEJE na sklepie.\n`);
      continue;
    }
    console.log(`Typ: ${def.type}  (id: ${def.id}, name: "${def.name}")`);
    console.log('Pola:');
    for (const f of def.fieldDefinitions) {
      console.log(`  - key="${f.key}"  name="${f.name}"  type=${f.type.name}  required=${f.required}`);
    }
    console.log('');
  }

  console.log('=== Istniejące wpisy ===\n');
  for (const type of ['poziom_skali', 'skala_sensoryczna']) {
    try {
      const entries = await fetchAllEntries({ store, token, type });
      console.log(`${type}: ${entries.length} wpisów`);
      for (const e of entries) {
        console.log(`  - ${e.handle} (${e.id})`);
        for (const f of e.fields) {
          const preview = String(f.value ?? '').length > 100 ? `${String(f.value).slice(0, 100)}…` : f.value;
          console.log(`      ${f.key} [${f.type}] = ${preview}`);
        }
      }
      console.log('');
    } catch (err) {
      console.log(`${type}: BŁĄD zapytania — ${err.message}\n`);
    }
  }

  console.log('=== Metafieldy produktowe (custom.skale, custom.karta_produktu) ===\n');
  for (const key of ['skale', 'karta_produktu']) {
    const data = await shopifyGraphQL({
      store,
      token,
      query: METAFIELD_DEF_QUERY,
      variables: { namespace: 'custom', key },
    });
    const nodes = data.metafieldDefinitions.nodes;
    if (nodes.length === 0) {
      console.log(`custom.${key}: BRAK definicji metafieldu`);
      continue;
    }
    for (const n of nodes) {
      console.log(`custom.${key}: type=${n.type.name}`);
      if (n.validations?.length) {
        for (const v of n.validations) console.log(`    validation ${v.name} = ${v.value}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
