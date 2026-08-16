#!/usr/bin/env node
// Import metaobiektów do Shopify przez Admin GraphQL API, na podstawie eksportu
// z Matrixify (.xlsx). Zastępuje Matrixify dla treści MMW.
//
// Użycie:
//   node import-metaobjects.mjs --file ./dane.xlsx            (dry-run, domyślnie)
//   node import-metaobjects.mjs --file ./dane.xlsx --commit    (realny import)

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import xlsx from 'xlsx';

dotenv.config();

const API_VERSION = '2026-07';

// Pola typu File reference (obraz/ikona) — u nas zdjęcia wgrywane ręcznie
// w adminie, więc wartość z Matrixify (nazwa pliku) nie nadaje się do
// metaobjectUpsert (API wymaga GID pliku). Te pola są pomijane przy imporcie.
const SKIP_FIELDS = ['obraz', 'ikona'];

const MUTATION = /* GraphQL */ `
  mutation MmwMetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject {
        id
        handle
        type
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

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

function readSheet(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames.find((name) => /metaobject/i.test(name)) ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet, { defval: '' });
}

// Wiersze Matrixify dla metaobiektów: jeden wpis rozbity na wiele wierszy,
// sklejonych po kolumnie Handle. Tylko "Top Row" niesie ID/Command/Definition,
// kolejne wiersze niosą tylko Field/Value dla tego samego Handle.
function groupRowsByHandle(rows) {
  const entries = new Map();
  let currentHandle = null;

  for (const row of rows) {
    const handle = String(row['Handle'] ?? '').trim();
    const isTopRow = String(row['Top Row'] ?? '').trim().toUpperCase() === 'TRUE' || row['Top Row'] === true;

    if (handle) {
      currentHandle = handle;
    }
    if (!currentHandle) continue;

    if (!entries.has(currentHandle)) {
      entries.set(currentHandle, {
        handle: currentHandle,
        type: null,
        command: null,
        fields: [],
      });
    }
    const entry = entries.get(currentHandle);

    if (isTopRow || handle) {
      const definitionHandle = String(row['Definition: Handle'] ?? '').trim();
      const command = String(row['Command'] ?? '').trim();
      if (definitionHandle) entry.type = definitionHandle;
      if (command) entry.command = command;
    }

    const fieldKey = String(row['Field'] ?? '').trim();
    if (fieldKey) {
      if (SKIP_FIELDS.includes(fieldKey)) {
        console.log(`pominięto pole ${fieldKey} (plik podpinany ręcznie) — ${currentHandle}`);
      } else {
        const rawValue = row['Value'];
        entry.fields.push({
          key: fieldKey,
          value: rawValue === null || rawValue === undefined ? '' : String(rawValue),
        });
      }
    }
  }

  return [...entries.values()];
}

function validateEntry(entry) {
  const problems = [];
  if (!entry.handle) problems.push('brak Handle');
  if (!entry.type) problems.push('brak Definition: Handle (typ metaobiektu)');
  if (entry.fields.length === 0) problems.push('brak pól (Field/Value)');
  if (entry.command && entry.command.toUpperCase() === 'DELETE') problems.push('Command=DELETE nieobsługiwane przez ten skrypt');
  return problems;
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

async function upsertWithRetry({ store, token, entry, maxRetries, baseDelayMs }) {
  const variables = {
    handle: { type: entry.type, handle: entry.handle },
    metaobject: {
      fields: entry.fields.map(({ key, value }) => ({ key, value })),
    },
  };

  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query: MUTATION, variables });

    if (isThrottled(json)) {
      if (attempt > maxRetries) {
        return { ok: false, errors: ['Przekroczono limit prób po THROTTLED'] };
      }
      const waitMs = baseDelayMs * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    if (json.errors) {
      return { ok: false, errors: json.errors.map((e) => e.message) };
    }

    const userErrors = json.data?.metaobjectUpsert?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, errors: userErrors.map((e) => `${e.field ?? ''} ${e.message}`.trim()) };
    }

    return { ok: true, metaobject: json.data?.metaobjectUpsert?.metaobject };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('Brak pliku wejściowego. Użycie: node import-metaobjects.mjs --file <ścieżka.xlsx> [--commit]');
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!existsSync(filePath)) {
    console.error(`Plik nie istnieje: ${filePath}`);
    process.exit(1);
  }

  const rows = readSheet(filePath);
  const entries = groupRowsByHandle(rows).filter((e) => e.command?.toUpperCase() !== 'DELETE');

  console.log(`Wczytano ${rows.length} wierszy, zgrupowano w ${entries.length} wpisów metaobiektów.`);
  console.log(args.dryRun ? 'Tryb: DRY-RUN (nic nie zostanie wysłane do Shopify)' : 'Tryb: COMMIT (realny import do Shopify)');
  console.log('');

  const invalid = [];
  const valid = [];
  for (const entry of entries) {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      invalid.push({ entry, problems });
    } else {
      valid.push(entry);
    }
  }

  if (invalid.length > 0) {
    console.log(`Pominięto ${invalid.length} wpisów z błędami walidacji:`);
    for (const { entry, problems } of invalid) {
      console.log(`  - ${entry.handle || '(brak handle)'}: ${problems.join(', ')}`);
    }
    console.log('');
  }

  if (args.dryRun) {
    valid.forEach((entry, i) => {
      console.log(`[${i + 1}/${valid.length}] ${entry.type}:${entry.handle} — ${entry.fields.length} pól`);
      for (const field of entry.fields) {
        const preview = field.value.length > 80 ? `${field.value.slice(0, 80)}…` : field.value;
        console.log(`    ${field.key} = ${preview}`);
      }
    });
    console.log('');
    console.log(`Podsumowanie (dry-run): ${valid.length} do wysłania, ${invalid.length} pominiętych z powodu błędów.`);
    console.log('Aby wykonać realny import, uruchom z flagą --commit.');
    return;
  }

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w .env. Sprawdź plik scripts/.env.');
    process.exit(1);
  }

  const RATE_LIMIT_DELAY_MS = 550;
  const MAX_RETRIES = 5;
  const RETRY_BASE_DELAY_MS = 1000;

  const results = { ok: [], failed: [] };

  for (let i = 0; i < valid.length; i++) {
    const entry = valid[i];
    console.log(`[${i + 1}/${valid.length}] ${entry.type}:${entry.handle}`);

    try {
      const result = await upsertWithRetry({
        store,
        token,
        entry,
        maxRetries: MAX_RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
      });

      if (result.ok) {
        results.ok.push(entry.handle);
      } else {
        results.failed.push({ handle: entry.handle, errors: result.errors });
        console.log(`    BŁĄD: ${result.errors.join('; ')}`);
      }
    } catch (err) {
      results.failed.push({ handle: entry.handle, errors: [err.message] });
      console.log(`    BŁĄD: ${err.message}`);
    }

    if (i < valid.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log('');
  console.log('--- Raport końcowy ---');
  console.log(`OK: ${results.ok.length}`);
  console.log(`Błędy: ${results.failed.length}`);
  console.log(`Pominięte (walidacja): ${invalid.length}`);
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
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
