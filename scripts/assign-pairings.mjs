#!/usr/bin/env node
// Przypisuje propozycje podania (metaobiekty polecamy_do) do produktów (win)
// przez metafieldsSet, na podstawie arkusza "Przypisania" w pliku Matrixify/
// arkuszu roboczym (.xlsx). Osobny skrypt od import-metaobjects.mjs — inny
// kierunek danych (nie tworzy metaobiektów, tylko łączy istniejące z
// istniejącymi produktami).
//
// Użycie:
//   node assign-pairings.mjs --file ./przypisania.xlsx            (dry-run, domyślnie)
//   node assign-pairings.mjs --file ./przypisania.xlsx --commit    (realny zapis)

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import xlsx from 'xlsx';

dotenv.config();

const API_VERSION = '2026-07';
const SHEET_NAME = 'Przypisania';
// Nazwa kolumny z handle produktu zmieniała się między wersjami arkusza
// (dopisek "(POPRAW jeśli źle)" znikał, gdy poprawki były już naniesione).
const COL_PRODUCT_HANDLE_CANDIDATES = ['Handle produktu', 'Handle produktu (POPRAW jeśli źle)'];
const COL_PROPOSALS = 'Propozycje (handle metaobjektów)';

function resolveProductHandleColumn(rows) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const found = COL_PRODUCT_HANDLE_CANDIDATES.find((c) => headers.includes(c));
  if (!found) {
    throw new Error(
      `Nie znaleziono kolumny z handle produktu. Szukane nazwy: ${COL_PRODUCT_HANDLE_CANDIDATES.join(', ')}. Nagłówki w arkuszu: ${headers.join(', ')}`
    );
  }
  return found;
}

const METAFIELD_NAMESPACE = 'custom';
const METAFIELD_KEY = 'polecamy_do';
const METAFIELD_TYPE = 'list.metaobject_reference';
const METAOBJECT_TYPE = 'polecamy_do';

const RATE_LIMIT_DELAY_MS = 550;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const PAGE_SIZE = 250;

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

function readAssignmentRows(filePath) {
  const workbook = xlsx.readFile(filePath);
  if (!workbook.SheetNames.includes(SHEET_NAME)) {
    throw new Error(`Brak arkusza "${SHEET_NAME}" w pliku. Dostępne arkusze: ${workbook.SheetNames.join(', ')}`);
  }
  const sheet = workbook.Sheets[SHEET_NAME];
  return xlsx.utils.sheet_to_json(sheet, { defval: '' });
}

function buildAssignments(rows) {
  const assignments = [];
  const skipped = [];
  const productHandleColumn = resolveProductHandleColumn(rows);

  for (const row of rows) {
    const productHandle = String(row[productHandleColumn] ?? '').trim();
    const proposalsRaw = String(row[COL_PROPOSALS] ?? '').trim();

    if (!productHandle || !proposalsRaw) {
      skipped.push({ row, reason: !productHandle ? 'brak handle produktu' : 'brak propozycji' });
      continue;
    }

    const proposalHandles = proposalsRaw
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    if (proposalHandles.length === 0) {
      skipped.push({ row, reason: 'brak propozycji' });
      continue;
    }

    assignments.push({ productHandle, proposalHandles });
  }

  return { assignments, skipped };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  return res.json();
}

function isThrottled(json) {
  const codes = (json.errors ?? []).map((e) => e.extensions?.code);
  return codes.includes('THROTTLED');
}

async function graphqlWithRetry({ store, token, query, variables }) {
  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query, variables });

    if (isThrottled(json)) {
      if (attempt > MAX_RETRIES) {
        throw new Error('Przekroczono limit prób po THROTTLED');
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    if (json.errors) {
      throw new Error(json.errors.map((e) => e.message).join('; '));
    }

    return json.data;
  }
}

const METAOBJECTS_QUERY = /* GraphQL */ `
  query MmwMetaobjects($type: String!, $cursor: String) {
    metaobjects(type: $type, first: ${PAGE_SIZE}, after: $cursor) {
      edges {
        node {
          id
          handle
          field(key: "tytul") {
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

const PRODUCTS_QUERY = /* GraphQL */ `
  query MmwProducts($cursor: String) {
    products(first: ${PAGE_SIZE}, after: $cursor) {
      edges {
        node {
          id
          handle
          title
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const METAFIELD_DEFINITION_QUERY = /* GraphQL */ `
  query MmwMetafieldDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(ownerType: PRODUCT, namespace: $namespace, key: $key, first: 1) {
      edges {
        node {
          type {
            name
          }
        }
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
        namespace
        ownerType
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function fetchAllMetaobjectHandles({ store, token }) {
  const map = new Map(); // handle -> { id, title }
  let cursor = null;

  while (true) {
    const data = await graphqlWithRetry({
      store,
      token,
      query: METAOBJECTS_QUERY,
      variables: { type: METAOBJECT_TYPE, cursor },
    });
    const connection = data.metaobjects;
    for (const edge of connection.edges) {
      map.set(edge.node.handle, { id: edge.node.id, title: edge.node.field?.value ?? '' });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return map;
}

async function fetchAllProductHandles({ store, token }) {
  const map = new Map(); // handle -> { id, title }
  let cursor = null;

  while (true) {
    const data = await graphqlWithRetry({
      store,
      token,
      query: PRODUCTS_QUERY,
      variables: { cursor },
    });
    const connection = data.products;
    for (const edge of connection.edges) {
      map.set(edge.node.handle, { id: edge.node.id, title: edge.node.title });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return map;
}

async function checkMetafieldDefinitionType({ store, token }) {
  const data = await graphqlWithRetry({
    store,
    token,
    query: METAFIELD_DEFINITION_QUERY,
    variables: { namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY },
  });
  const edge = data.metafieldDefinitions.edges[0];
  if (!edge) {
    throw new Error(
      `Brak definicji metapola ${METAFIELD_NAMESPACE}.${METAFIELD_KEY} dla produktów w sklepie. Utwórz ją (typ ${METAFIELD_TYPE}) przed importem.`
    );
  }
  const actualType = edge.node.type.name;
  if (actualType !== METAFIELD_TYPE) {
    throw new Error(
      `Definicja metapola ${METAFIELD_NAMESPACE}.${METAFIELD_KEY} ma typ "${actualType}", oczekiwano "${METAFIELD_TYPE}". Popraw typ definicji w adminie przed importem — API odrzuci zapis przy złym typie.`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('Brak pliku wejściowego. Użycie: node assign-pairings.mjs --file <ścieżka.xlsx> [--commit]');
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

  console.log(args.dryRun ? 'Tryb: DRY-RUN (bez zapisu do Shopify)' : 'Tryb: COMMIT (realny zapis do Shopify)');
  console.log('Uwaga: mapowanie handle → GID wymaga odczytu z API sklepu nawet w dry-run.');
  console.log('');

  const rows = readAssignmentRows(filePath);
  const { assignments, skipped } = buildAssignments(rows);

  console.log(`Wczytano ${rows.length} wierszy z arkusza "${SHEET_NAME}".`);
  console.log(`Do przetworzenia: ${assignments.length}, pominięte (brak handle/propozycji): ${skipped.length}.`);
  console.log('');

  console.log('Sprawdzam definicję metapola custom.polecamy_do...');
  await checkMetafieldDefinitionType({ store, token });
  console.log(`OK — typ metapola to ${METAFIELD_TYPE}.`);
  console.log('');

  console.log('Pobieram metaobjekty typu polecamy_do...');
  const metaobjectMap = await fetchAllMetaobjectHandles({ store, token });
  console.log(`Znaleziono ${metaobjectMap.size} metaobiektów polecamy_do.`);

  console.log('Pobieram produkty...');
  const productMap = await fetchAllProductHandles({ store, token });
  console.log(`Znaleziono ${productMap.size} produktów.`);
  console.log('');

  const resolved = [];
  const errors = [];

  for (const { productHandle, proposalHandles } of assignments) {
    const product = productMap.get(productHandle);
    if (!product) {
      errors.push(`${productHandle}: nie znaleziono produktu o tym handle — wiersz pominięty`);
      continue;
    }

    const proposalGids = [];
    const proposalLabels = [];
    for (const proposalHandle of proposalHandles) {
      const metaobject = metaobjectMap.get(proposalHandle);
      if (!metaobject) {
        console.log(`  OSTRZEŻENIE: ${productHandle} — nie znaleziono metaobiektu polecamy_do o handle "${proposalHandle}", pomijam tę propozycję`);
        continue;
      }
      proposalGids.push(metaobject.id);
      proposalLabels.push(`${proposalHandle} (${metaobject.title || 'bez tytułu'})`);
    }

    if (proposalGids.length === 0) {
      errors.push(`${productHandle}: żadna z propozycji nie została znaleziona jako metaobiekt — wiersz pominięty`);
      continue;
    }

    resolved.push({
      productHandle,
      productId: product.id,
      productTitle: product.title,
      proposalGids,
      proposalLabels,
    });
  }

  if (skipped.length > 0) {
    console.log('');
    console.log(`Pominięte wiersze (${skipped.length}):`);
    const productHandleColumn = resolveProductHandleColumn(rows);
    for (const { row, reason } of skipped) {
      const label = row[productHandleColumn] || row['Nazwa (arkusz Marka)'] || '(bez nazwy)';
      console.log(`  - ${label}: ${reason}`);
    }
  }

  console.log('');
  resolved.forEach((r, i) => {
    console.log(`[${i + 1}/${resolved.length}] ${r.productHandle} (${r.productTitle}) — ${r.proposalGids.length} propozycji:`);
    for (const label of r.proposalLabels) {
      console.log(`    - ${label}`);
    }
  });

  if (errors.length > 0) {
    console.log('');
    console.log(`Wiersze z błędami (${errors.length}):`);
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
  }

  if (args.dryRun) {
    console.log('');
    console.log(`Podsumowanie (dry-run): ${resolved.length} produktów do zaktualizowania, ${errors.length} błędów, ${skipped.length} pominiętych wierszy.`);
    console.log('Aby wykonać realny zapis, uruchom z flagą --commit.');
    return;
  }

  console.log('');
  console.log('Zapisuję metapola...');

  const results = { ok: [], failed: [] };

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    console.log(`[${i + 1}/${resolved.length}] ${r.productHandle}`);

    const variables = {
      metafields: [
        {
          ownerId: r.productId,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: METAFIELD_TYPE,
          value: JSON.stringify(r.proposalGids),
        },
      ],
    };

    try {
      let attempt = 0;
      let data;
      while (true) {
        attempt++;
        const json = await shopifyGraphQL({ store, token, query: METAFIELDS_SET_MUTATION, variables });

        if (isThrottled(json)) {
          if (attempt > MAX_RETRIES) throw new Error('Przekroczono limit prób po THROTTLED');
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));

        data = json.data;
        break;
      }

      const userErrors = data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        results.failed.push({ handle: r.productHandle, errors: userErrors.map((e) => `${e.field ?? ''} ${e.message}`.trim()) });
        console.log(`    BŁĄD: ${userErrors.map((e) => e.message).join('; ')}`);
      } else {
        results.ok.push(r.productHandle);
      }
    } catch (err) {
      results.failed.push({ handle: r.productHandle, errors: [err.message] });
      console.log(`    BŁĄD: ${err.message}`);
    }

    if (i < resolved.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log('');
  console.log('--- Raport końcowy ---');
  console.log(`Zaktualizowano: ${results.ok.length}`);
  console.log(`Błędy: ${results.failed.length}`);
  console.log(`Pominięte (walidacja przed zapisem): ${errors.length + skipped.length}`);
  if (results.failed.length > 0) {
    console.log('');
    console.log('Handle z błędami:');
    for (const f of results.failed) {
      console.log(`  - ${f.handle}: ${f.errors.join('; ')}`);
    }
  }

  if (results.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
