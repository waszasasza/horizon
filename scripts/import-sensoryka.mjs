#!/usr/bin/env node
// Import skal sensorycznych (skala_sensoryczna + poziom_skali) z scripts/sensoryka-dane.json
// przez Admin GraphQL API. Idempotentny — wyłącznie metaobjectUpsert po handle.
//
// WAŻNE — kolejność faz (odwrotnie niż "poziomy, potem skale"): sprawdzone w Kroku 0,
// że poziom_skali.skala referencjonuje skala_sensoryczna (nie odwrotnie —
// skala_sensoryczna.etykieta to zwykła lista stringów, nie referencje). Fazy muszą więc
// iść: 1) skala_sensoryczna, 2) rozwiązanie handle->GID, 3) poziom_skali.
//
// Ikony (pole "ikona") CELOWO pominięte w payloadach — wgrywane ręcznie w adminie.
//
// Użycie:
//   node import-sensoryka.mjs                 (dry-run, domyślnie, nic nie wysyła)
//   node import-sensoryka.mjs --commit         (realny import)
//   node import-sensoryka.mjs --file inna-sciezka.json

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { resolveMetaobjectGid } from './lib/resolve-metaobject-handle.mjs';
import { fetchAllMetaobjects } from './lib/fetch-metaobjects.mjs';

dotenv.config();

const API_VERSION = '2026-07';
const SKALA_TYPE = 'skala_sensoryczna';
const POZIOM_TYPE = 'poziom_skali';
const HANDLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // ASCII, bez polskich znaków

const UPSERT_MUTATION = /* GraphQL */ `
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
  const args = { dryRun: true, file: 'sensoryka-dane.json' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--file') { args.file = argv[i + 1]; i++; }
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
  }
  return args;
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

async function upsertWithRetry({ store, token, handle, metaobject, maxRetries = 5, baseDelayMs = 1000 }) {
  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query: UPSERT_MUTATION, variables: { handle, metaobject } });

    if (isThrottled(json)) {
      if (attempt > maxRetries) return { ok: false, errors: ['Przekroczono limit prób po THROTTLED'] };
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }
    if (json.errors) return { ok: false, errors: json.errors.map((e) => e.message) };

    const userErrors = json.data?.metaobjectUpsert?.userErrors ?? [];
    if (userErrors.length > 0) return { ok: false, errors: userErrors.map((e) => `${e.field ?? ''} ${e.message}`.trim()) };

    return { ok: true, metaobject: json.data?.metaobjectUpsert?.metaobject };
  }
}

// --- Walidacja danych wejściowych (Krok 3) ---
function validate(data) {
  const problems = [];
  const skale = data.skale ?? [];

  if (skale.length !== 4) {
    problems.push(`Oczekiwano dokładnie 4 skal, znaleziono ${skale.length}.`);
  }

  const skalaHandles = new Set();
  const allPoziomHandles = new Set();
  let totalPoziomy = 0;

  for (const skala of skale) {
    if (!HANDLE_RE.test(skala.handle ?? '')) {
      problems.push(`Handle skali "${skala.handle}" zawiera niedozwolone znaki (tylko a-z0-9-).`);
    }
    if (skalaHandles.has(skala.handle)) {
      problems.push(`Zduplikowany handle skali: "${skala.handle}".`);
    }
    skalaHandles.add(skala.handle);

    const poziomy = skala.poziomy ?? [];
    if (poziomy.length !== 3) {
      problems.push(`Skala "${skala.handle}" ma ${poziomy.length} poziomów (oczekiwano 3).`);
    }
    totalPoziomy += poziomy.length;

    const wartosci = new Set();
    for (const poziom of poziomy) {
      if (!HANDLE_RE.test(poziom.handle ?? '')) {
        problems.push(`Handle poziomu "${poziom.handle}" zawiera niedozwolone znaki (tylko a-z0-9-).`);
      }
      if (allPoziomHandles.has(poziom.handle)) {
        problems.push(`Zduplikowany handle poziomu: "${poziom.handle}".`);
      }
      allPoziomHandles.add(poziom.handle);

      if (![1, 2, 3].includes(poziom.wartosc)) {
        problems.push(`Poziom "${poziom.handle}": wartosc=${poziom.wartosc} poza zakresem 1-3.`);
      }
      wartosci.add(poziom.wartosc);
    }
    if (wartosci.size !== poziomy.length) {
      problems.push(`Skala "${skala.handle}" ma zduplikowane wartości poziomów.`);
    }
  }

  if (totalPoziomy !== 12) {
    problems.push(`Oczekiwano dokładnie 12 poziomów łącznie, znaleziono ${totalPoziomy}.`);
  }

  return problems;
}

function buildSkalaMutation(skala) {
  // Sortowanie po wartosc — porządek etykiet MUSI odpowiadać indeksowi używanemu
  // w Liquid (blocks/mmw-sensory-scales.liquid: active_index = wartosc - 1).
  const sortedPoziomy = [...skala.poziomy].sort((a, b) => a.wartosc - b.wartosc);
  const etykiety = sortedPoziomy.map((p) => p.etykieta);

  const fields = [
    { key: 'nazwa', value: skala.nazwa },
    { key: 'etykieta', value: JSON.stringify(etykiety) },
  ];
  // "ikona" i "kolor" celowo pominięte — wgrywane ręcznie w adminie (nie nadpisujemy
  // ani nie zostawiamy pustego stringa, po prostu nie wysyłamy tego pola).

  return {
    handle: { type: SKALA_TYPE, handle: skala.handle },
    metaobject: { fields },
  };
}

function buildPoziomMutation(skala, poziom, skalaGid) {
  const fields = [
    { key: 'wartosc', value: String(poziom.wartosc) },
    { key: 'skala', value: skalaGid },
    { key: 'nazwa', value: `${skala.nazwa} – ${poziom.etykieta}` },
  ];
  return {
    handle: { type: POZIOM_TYPE, handle: poziom.handle },
    metaobject: { fields },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(args.file);

  if (!existsSync(filePath)) {
    console.error(`Plik nie istnieje: ${filePath}`);
    process.exit(1);
  }

  const data = JSON.parse(await readFile(filePath, 'utf8'));
  const problems = validate(data);

  console.log(`Wczytano ${filePath}`);
  console.log(args.dryRun ? 'Tryb: DRY-RUN (nic nie zostanie wysłane do Shopify)' : 'Tryb: COMMIT (realny import)');
  console.log('');

  if (problems.length > 0) {
    console.log('BŁĘDY WALIDACJI — przerwano, nic nie zostało wysłane:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('Walidacja OK: 4 skale × 3 poziomy, wartości 1-3 unikalne, handle bez polskich znaków, brak duplikatów.\n');

  const skalaMutations = data.skale.map(buildSkalaMutation);

  console.log(`=== Faza 1: metaobjectUpsert ${SKALA_TYPE} (${skalaMutations.length}) ===\n`);
  for (const m of skalaMutations) {
    console.log(`${SKALA_TYPE}:${m.handle.handle}`);
    for (const f of m.metaobject.fields) console.log(`    ${f.key} = ${f.value}`);
    console.log('    (ikona, kolor: pominięte — do ręcznego wgrania w adminie)');
  }

  console.log(`\n=== Faza 2: rozwiązanie handle -> GID (${SKALA_TYPE}) ===\n`);
  if (args.dryRun) {
    console.log('(pominięte w dry-run — skale jeszcze nie istnieją, nie ma czego rozwiązywać)');
  }

  console.log(`\n=== Faza 3: metaobjectUpsert ${POZIOM_TYPE} (12) ===\n`);
  for (const skala of data.skale) {
    const sortedPoziomy = [...skala.poziomy].sort((a, b) => a.wartosc - b.wartosc);
    for (const poziom of sortedPoziomy) {
      const gidPlaceholder = args.dryRun
        ? `<GID skali "${skala.handle}" — rozwiązany po Fazie 1 przy --commit>`
        : null;
      console.log(`${POZIOM_TYPE}:${poziom.handle}`);
      console.log(`    wartosc = ${poziom.wartosc}`);
      console.log(`    skala = ${gidPlaceholder ?? '(rozwiązywane na żywo)'}`);
      console.log(`    nazwa = ${skala.nazwa} – ${poziom.etykieta}`);
    }
  }

  if (args.dryRun) {
    console.log('\nAby wykonać realny import, uruchom z flagą --commit.');
    return;
  }

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error('\nBrak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w scripts/.env');
    process.exit(1);
  }

  const RATE_LIMIT_DELAY_MS = 550;
  const report = { skala: { ok: [], failed: [] }, poziom: { ok: [], failed: [] } };
  const skalaGids = new Map();

  // Zrzut stanu PRZED jakąkolwiek mutacją — punkt odniesienia do porównania/rollbacku.
  console.log('\n--- Zrzut stanu PRZED zmianą ---');
  const [przedSkale, przedPoziomy] = await Promise.all([
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQL, type: SKALA_TYPE }),
    fetchAllMetaobjects({ store, token, graphql: shopifyGraphQL, type: POZIOM_TYPE }),
  ]);
  const przedPath = path.resolve(`sensoryka-stan-przed-${Date.now()}.json`);
  await writeFile(
    przedPath,
    JSON.stringify({ zapisano: new Date().toISOString(), skala_sensoryczna: przedSkale, poziom_skali: przedPoziomy }, null, 2),
    'utf8'
  );
  console.log(`Zapisano ${przedSkale.length} skala_sensoryczna + ${przedPoziomy.length} poziom_skali -> ${przedPath}`);

  // Zrzut stanu PO (częściowy, na wypadek przerwania) — nadpisywany na końcu każdej fazy/przerwania.
  async function zapiszStanPo() {
    const poPath = path.resolve('sensoryka-stan-po.json');
    await writeFile(
      poPath,
      JSON.stringify(
        {
          zapisano: new Date().toISOString(),
          skala_sensoryczna: Object.fromEntries(skalaGids),
          poziom_skali_ok: report.poziom.ok,
          bledy: [...report.skala.failed, ...report.poziom.failed],
        },
        null,
        2
      ),
      'utf8'
    );
    return poPath;
  }

  console.log('\n--- Wykonywanie Fazy 1 (skala_sensoryczna) ---');
  for (const m of skalaMutations) {
    const handle = m.handle.handle;
    const result = await upsertWithRetry({ store, token, handle: m.handle, metaobject: m.metaobject });
    if (result.ok) {
      report.skala.ok.push(handle);
      skalaGids.set(handle, result.metaobject.id);
      console.log(`  OK  ${handle} -> ${result.metaobject.id}`);
    } else {
      report.skala.failed.push({ handle, errors: result.errors });
      console.log(`  BŁĄD  ${handle}: ${result.errors.join('; ')}`);
      console.log('  Przerwano na pierwszym błędzie (userErrors) — Faza 2/3 NIE zostały uruchomione.');
      const poPath = await zapiszStanPo();
      console.log(`  Zrzut stanu (częściowy) zapisany do ${poPath}. Stan PRZED: ${przedPath}`);
      process.exit(1);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log('\n--- Faza 2: weryfikacja GID przez query (nie z cache odpowiedzi Fazy 1) ---');
  for (const skala of data.skale) {
    const gid = await resolveMetaobjectGid({ store, token, graphql: shopifyGraphQL, type: SKALA_TYPE, handle: skala.handle });
    if (!gid) {
      console.log(`  BŁĄD  Nie udało się zweryfikować GID dla "${skala.handle}" po Fazie 1 — przerwano.`);
      const poPath = await zapiszStanPo();
      console.log(`  Zrzut stanu (częściowy) zapisany do ${poPath}. Stan PRZED: ${przedPath}`);
      process.exit(1);
    }
    skalaGids.set(skala.handle, gid);
  }

  console.log('\n--- Wykonywanie Fazy 3 (poziom_skali) ---');
  for (const skala of data.skale) {
    const skalaGid = skalaGids.get(skala.handle);
    const sortedPoziomy = [...skala.poziomy].sort((a, b) => a.wartosc - b.wartosc);
    for (const poziom of sortedPoziomy) {
      const m = buildPoziomMutation(skala, poziom, skalaGid);
      const result = await upsertWithRetry({ store, token, handle: m.handle, metaobject: m.metaobject });
      if (result.ok) {
        report.poziom.ok.push(poziom.handle);
        console.log(`  OK  ${poziom.handle} -> ${result.metaobject.id}`);
      } else {
        report.poziom.failed.push({ handle: poziom.handle, errors: result.errors });
        console.log(`  BŁĄD  ${poziom.handle}: ${result.errors.join('; ')}`);
        console.log('  Przerwano na pierwszym błędzie (userErrors) — pozostałe poziomy NIE zostały wysłane.');
        const poPath = await zapiszStanPo();
        console.log(`  Zrzut stanu (częściowy) zapisany do ${poPath}. Stan PRZED: ${przedPath}`);
        process.exit(1);
      }
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log('\n--- Raport końcowy ---');
  console.log(`skala_sensoryczna: OK ${report.skala.ok.length}/${skalaMutations.length}`);
  console.log(`poziom_skali: OK ${report.poziom.ok.length}/12`);

  const poPath = await zapiszStanPo();
  console.log(`\nZrzut stanu PO zapisany do ${poPath}`);
  console.log(`Zrzut stanu PRZED (do porównania): ${przedPath}`);

  if (report.skala.failed.length > 0 || report.poziom.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
