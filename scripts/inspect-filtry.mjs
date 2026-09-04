#!/usr/bin/env node
/**
 * inspect-filtry.mjs
 *
 * READ-ONLY. Nic nie zapisuje do Shopify — brak jakiejkolwiek mutacji GraphQL
 * w tym pliku, celowo (diagnoza wizualnej różnicy w panelu filtrów kolekcji,
 * zero zmian w danych katalogowych).
 *
 * Ustala, do jakiej kategorii danych należą konkretne, pogrubione/wersalikowe
 * pozycje widoczne w panelu filtrów (np. "KOSMETYKI KSIĄŻĘCE") — Product type,
 * Vendor, czy zwykły tag — żeby rozstrzygnąć, czy to osobne grupy filtrów, czy
 * wartości tego samego filtra tagowego co reszta.
 *
 * Konfiguracja Search & Discovery (które facety są włączone w adminie) NIE MA
 * udokumentowanego publicznego Admin API — próba zapytania o nią kończy się
 * degradacją (patrz fetchSearchDiscoveryConfig), a skrypt i tak liczy
 * productType/vendor/tag bezpośrednio z produktów jako obejście.
 *
 * Uzycie:
 *   node scripts/inspect-filtry.mjs
 *   node scripts/inspect-filtry.mjs --json raport-filtry.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2026-07';

if (!STORE || !TOKEN) {
  console.error('Brak SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN w scripts/.env');
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
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
    const err = new Error('GraphQL error');
    err.graphqlErrors = json.errors;
    throw err;
  }
  return json.data;
}

async function fetchShopName() {
  const data = await gql(`{ shop { name myshopifyDomain } }`);
  return data.shop;
}

// ---------------------------------------------------- KROK 3: konfiguracja S&D
// Nie ma udokumentowanego publicznego zapytania Admin API zwracającego
// konfigurację filtrów aplikacji Search & Discovery (to wewnętrzny stan
// aplikacji, nie encja GraphQL). Jedyna rzecz zbliżona do tego, do której
// zwykły custom-app token MOŻE mieć dostęp, to metapola aplikacji na obiekcie
// shop (namespace zaczynający się od "app--") — próbujemy, degradujemy przy
// odmowie dostępu, tak jak fetchRedirects w audit-architektura.mjs.
async function fetchSearchDiscoveryConfig() {
  try {
    const data = await gql(
      `{
        shop {
          metafields(first: 50) {
            nodes { namespace key type }
          }
        }
      }`
    );
    const nodes = data.shop.metafields.nodes;
    const relevant = nodes.filter(
      (n) => /search|discovery|facet|filter/i.test(n.namespace) || /search|discovery|facet|filter/i.test(n.key)
    );
    return { available: true, allShopMetafields: nodes, relevant };
  } catch (err) {
    const accessDenied = err.graphqlErrors?.some((e) => e.extensions?.code === 'ACCESS_DENIED');
    return { available: false, accessDenied, error: accessDenied ? null : err.message };
  }
}

// -------------------------------------------------------- dane katalogowe

async function fetchAllProductFacets() {
  const productTypes = new Map(); // value -> count
  const vendors = new Map();
  const tags = new Map();
  let cursor = null;
  let total = 0;

  do {
    const data = await gql(
      `query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { productType vendor tags }
        }
      }`,
      { cursor }
    );
    for (const n of data.products.nodes) {
      total += 1;
      const pt = (n.productType ?? '').trim();
      if (pt) productTypes.set(pt, (productTypes.get(pt) ?? 0) + 1);
      const v = (n.vendor ?? '').trim();
      if (v) vendors.set(v, (vendors.get(v) ?? 0) + 1);
      for (const t of n.tags ?? []) {
        const tt = t.trim();
        if (tt) tags.set(tt, (tags.get(tt) ?? 0) + 1);
      }
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return { total, productTypes, vendors, tags };
}

async function fetchProductMetafieldDefinitions() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        metafieldDefinitions(first: 100, after: $cursor, ownerType: PRODUCT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            namespace
            key
            name
            type { name }
            access { storefront }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.metafieldDefinitions.nodes);
    cursor = data.metafieldDefinitions.pageInfo.hasNextPage
      ? data.metafieldDefinitions.pageInfo.endCursor
      : null;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------- helpers

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function printTable(title, entries, limit = 100) {
  console.log('');
  console.log('='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
  if (entries.length === 0) {
    console.log('  (brak)');
    return;
  }
  entries.slice(0, limit).forEach(([value, count]) => {
    console.log(`  ${String(count).padStart(4)}  ${value}`);
  });
  if (entries.length > limit) {
    console.log(`  ... i ${entries.length - limit} więcej`);
  }
}

// Konkretne nazwy z hipotezy w zadaniu — sprawdzamy wprost, w której kategorii
// się znajdują (case-insensitive, bo dane w adminie mogą mieć inną wielkość
// liter niż to, co widać po ewentualnym text-transform w CSS).
const NAZWY_DO_ROZSTRZYGNIECIA = [
  'Kosmetyki książęce',
  'Zestawy prezentowe',
  'Winnica Pałac Mała Wieś',
];

function findCategory(name, { productTypes, vendors, tags }) {
  const norm = (s) => s.toLowerCase().trim();
  const target = norm(name);
  const hits = [];
  for (const [v] of productTypes) if (norm(v) === target) hits.push({ kategoria: 'productType', wartosc: v });
  for (const [v] of vendors) if (norm(v) === target) hits.push({ kategoria: 'vendor', wartosc: v });
  for (const [v] of tags) if (norm(v) === target) hits.push({ kategoria: 'tag', wartosc: v });
  return hits;
}

async function main() {
  console.log('Łączę się ze sklepem...');
  const shop = await fetchShopName();
  console.log(`Sklep: ${shop.name} (${shop.myshopifyDomain})`);

  console.log('\nPróba odczytu konfiguracji Search & Discovery (metapola shop)...');
  const sd = await fetchSearchDiscoveryConfig();
  if (!sd.available) {
    if (sd.accessDenied) {
      console.log(
        '  NIEDOSTĘPNE: ACCESS_DENIED — token nie ma scope do odczytu metapól sklepu, albo API nie eksponuje ' +
          'konfiguracji Search & Discovery w ten sposób. Przechodzę na dane pośrednie (productType/vendor/tag).'
      );
    } else {
      console.log(`  NIEDOSTĘPNE (błąd inny niż ACCESS_DENIED): ${sd.error}`);
    }
  } else {
    console.log(`  Metapola sklepu: ${sd.allShopMetafields.length} znalezionych, ${sd.relevant.length} pasujących do "search/discovery/facet/filter" w nazwie.`);
    sd.relevant.forEach((n) => console.log(`    ${n.namespace}.${n.key} (${n.type})`));
    if (sd.relevant.length === 0) {
      console.log('  Brak metapól app-owych powiązanych z Search & Discovery widocznych przez ten token — jak oczekiwano (to nie jest udokumentowany mechanizm).');
    }
  }

  console.log('\nPobieram productType/vendor/tags ze wszystkich produktów...');
  const facets = await fetchAllProductFacets();
  console.log(`  Przetworzono produktów: ${facets.total}`);
  console.log(`  Unikalnych productType: ${facets.productTypes.size}`);
  console.log(`  Unikalnych vendor: ${facets.vendors.size}`);
  console.log(`  Unikalnych tagów: ${facets.tags.size}`);

  printTable('PRODUCT TYPE (z licznikami)', sortedEntries(facets.productTypes));
  printTable('VENDOR (z licznikami)', sortedEntries(facets.vendors));
  printTable('TAGI (z licznikami)', sortedEntries(facets.tags));

  console.log('\nPobieram definicje metapól produktowych...');
  const metafieldDefs = await fetchProductMetafieldDefinitions();
  console.log(`  Definicji metapól PRODUCT: ${metafieldDefs.length}`);
  const storefrontVisible = metafieldDefs.filter((d) => d.access?.storefront && d.access.storefront !== 'NONE');
  console.log(`  Z dostępem storefront (PUBLIC_READ/inne niż NONE): ${storefrontVisible.length}`);
  console.log('');
  console.log('='.repeat(70));
  console.log('METAPOLA PRODUKTOWE — dostęp storefront');
  console.log('='.repeat(70));
  metafieldDefs
    .sort((a, b) => `${a.namespace}.${a.key}`.localeCompare(`${b.namespace}.${b.key}`))
    .forEach((d) => {
      console.log(
        `  ${d.access?.storefront ?? 'NONE'}`.padEnd(14) +
          `${d.namespace}.${d.key}  (${d.type?.name ?? '?'})  "${d.name}"`
      );
    });

  console.log('\n');
  console.log('='.repeat(70));
  console.log('ROZSTRZYGNIĘCIE HIPOTEZY — do jakiej kategorii należą te nazwy?');
  console.log('='.repeat(70));
  const rozstrzygniecie = {};
  for (const name of NAZWY_DO_ROZSTRZYGNIECIA) {
    const hits = findCategory(name, facets);
    rozstrzygniecie[name] = hits;
    if (hits.length === 0) {
      console.log(`  "${name}"  ->  NIE ZNALEZIONO dokładnego dopasowania w productType/vendor/tag`);
    } else {
      hits.forEach((h) => console.log(`  "${name}"  ->  ${h.kategoria}  (dokładna wartość w danych: "${h.wartosc}")`));
    }
  }

  if (JSON_OUT) {
    const report = {
      shop: { name: shop.name, domain: shop.myshopifyDomain },
      searchDiscoveryConfig: sd,
      totals: {
        products: facets.total,
        productTypes: facets.productTypes.size,
        vendors: facets.vendors.size,
        tags: facets.tags.size,
      },
      productTypes: sortedEntries(facets.productTypes),
      vendors: sortedEntries(facets.vendors),
      tags: sortedEntries(facets.tags),
      metafieldDefinitions: metafieldDefs,
      rozstrzygniecie,
    };
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nPełny raport zapisany do ${JSON_OUT}`);
  }

  console.log('\nSkrypt nic nie zapisał w Shopify (read-only, brak mutacji GraphQL w tym pliku).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
