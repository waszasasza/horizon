#!/usr/bin/env node
// Wgrywa karty techniczne PDF (scripts/karty/) do biblioteki plików Shopify
// i podpina je jako custom.karta_produktu na 19 produktach zaakceptowanych
// w scripts/dopasowanie-kart.md (sekcja "Dopasowania pewne"). Lista dopasowań
// jest wpisana wprost poniżej (MATCHES) — to jednorazowa, ręcznie
// zweryfikowana paczka, nie powtarzalny import ze spreadsheetu, więc nie ma
// tu czytania xlsx jak w import-wina.mjs; kształt CLI (dry-run domyślny,
// --commit, retry/throttle, BATCH_SIZE=4, halt-on-error) skopiowany stamtąd.
//
// Dwa kroki, w tej kolejności, per plik/produkt:
//   1. stagedUploadsCreate -> POST bajtów -> fileCreate -> polling fileStatus
//      aż GenericFile/READY (podpięcie GID-a pliku w stanie przetwarzania
//      kończy się cicho zepsutą referencją — nie robimy tego).
//   2. metafieldsSet (custom.karta_produktu, file_reference) w paczkach po
//      max 4 produkty, dopiero gdy WSZYSTKIE pliki w danej paczce są READY.
//
// Pięć plików źródłowych ma sufiks "(N)" w nazwie (ślad jednorazowej
// ekstrakcji archiwum klienta, potwierdzone w dopasowanie-kart.md) — nazwa
// widoczna w bibliotece Shopify (i przy pobieraniu przez klienta) jest CZYSTA,
// bez sufiksu; ustawiana jawnie w polu `uploadFilename` niżej, nie wyliczana
// automatycznie z basename.
//
// ksiaze-regent-2024 ma już wypełnione custom.karta_produktu (przypadkowy
// placeholder Mac-5.webp, zaakceptowane do nadpisania) — stara wartość jest
// pobierana i wypisywana w raporcie PRZED nadpisaniem, żeby zostać w logu na
// wypadek gdyby ktoś tego pliku szukał.
//
// Użycie:
//   node import-karty-produktow.mjs                 (dry-run, domyślnie)
//   node import-karty-produktow.mjs --commit          (realny zapis)
//   node import-karty-produktow.mjs --dir ./karty     (domyślne --dir)

import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

const API_VERSION = '2026-07';
const RATE_LIMIT_DELAY_MS = 550;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const BATCH_SIZE = 4;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 30; // ~45s na plik, powinno z zapasem wystarczyć na PDF ~300KB

// ścieżka źródłowa (względem --dir) -> { handle, uploadFilename }
// uploadFilename ustawione jawnie tylko tam, gdzie różni się od basename
// (5 plików z sufiksem "(N)" — patrz komentarz na górze pliku).
const MATCHES = [
  { src: '2024/FENIX/PDF/Fenix Alfresco 2024.pdf', handle: 'fenix-blanc-alfresco' },
  { src: '2024/FENIX/PDF/Fenix Barrique 2024.pdf', handle: 'fenix-blanc-barrique' },
  { src: '2024/HISTORYCZNE/PDF/Książę Regent 2024.pdf', handle: 'ksiaze-regent-2024' },
  { src: '2024/HISTORYCZNE/PDF/Wojewoda 2024.pdf', handle: 'wojewoda-2024' },
  { src: '2024/POLINI/Polini Aperitivo.pdf', handle: 'polini-aperitivo' },
  { src: '2024/VICU/Flora 2024.pdf', handle: 'vicu-flora-2024' },
  { src: '2024/VICU/Medusa 2024.pdf', handle: 'vicu-medusa-2024' },
  { src: '2024/WPMW/Orange 2024.pdf', handle: 'orange-2024' },
  { src: '2024/WPMW/Regent 2024 (1).pdf', handle: 'regent-2024', uploadFilename: 'Regent 2024.pdf' },
  { src: '2024/WPMW/Rouge 2024.pdf', handle: 'rouge-2024' },
  { src: '2024/WPMW/Souvignier 2024.pdf', handle: 'souvignier-gris-2024' },
  { src: '2024/WPMW/solaris półwytrawny 2024.pdf', handle: 'solaris-powytrawny-2024' },
  { src: '2025/WPMW/Blanc 2025.pdf', handle: 'blanc-2025' },
  { src: '2025/WPMW/Johanniter 2025.pdf', handle: 'johanniter-2025' },
  { src: '2025/WPMW/Riesling 2025.pdf', handle: 'riesling-2025' },
  {
    src: '2025/WPMW/Riesling Barrique 2025 wytrawny (2).pdf',
    handle: 'riesling-barrique-2025',
    uploadFilename: 'Riesling Barrique 2025 wytrawny.pdf',
  },
  { src: '2025/WPMW/Rose 2025 (3).pdf', handle: 'rose-2025', uploadFilename: 'Rose 2025.pdf' },
  {
    src: '2025/WPMW/Solaris wytrawny 2025 (1).pdf',
    handle: 'solaris-wytrawny-2025',
    uploadFilename: 'Solaris wytrawny 2025.pdf',
  },
  { src: '2025/WPMW/muscaris 2025 (2).pdf', handle: 'muscaris-2025', uploadFilename: 'muscaris 2025.pdf' },
];

function parseArgs(argv) {
  const args = { dryRun: true, dir: './karty' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--dir') {
      args.dir = argv[i + 1];
      i++;
    } else if (arg.startsWith('--dir=')) {
      args.dir = arg.slice('--dir='.length);
    }
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

async function graphqlWithRetry({ store, token, query, variables }) {
  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query, variables });
    if (isThrottled(json)) {
      if (attempt > MAX_RETRIES) throw new Error('Przekroczono limit prób po THROTTLED');
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
    return json.data;
  }
}

const PRODUCT_QUERY = /* GraphQL */ `
  query MmwProductKarta($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      title
      karta: metafield(namespace: "custom", key: "karta_produktu") {
        value
        reference {
          ... on GenericFile {
            url
          }
          ... on MediaImage {
            image {
              url
            }
          }
        }
      }
    }
  }
`;

const STAGED_UPLOADS_CREATE = /* GraphQL */ `
  mutation MmwStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE = /* GraphQL */ `
  mutation MmwFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on GenericFile {
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_STATUS_QUERY = /* GraphQL */ `
  query MmwFileStatus($id: ID!) {
    node(id: $id) {
      ... on GenericFile {
        id
        fileStatus
        url
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
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function uploadPdf({ store, token, filePath, uploadFilename }) {
  const bytes = readFileSync(filePath);
  const fileSize = String(statSync(filePath).size);
  const mimeType = 'application/pdf';

  const stagedData = await graphqlWithRetry({
    store,
    token,
    query: STAGED_UPLOADS_CREATE,
    variables: {
      input: [{ resource: 'FILE', filename: uploadFilename, mimeType, fileSize, httpMethod: 'POST' }],
    },
  });
  const stagedErrors = stagedData.stagedUploadsCreate.userErrors;
  if (stagedErrors.length > 0) {
    throw new Error(`stagedUploadsCreate userErrors: ${JSON.stringify(stagedErrors, null, 2)}`);
  }
  const target = stagedData.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const { name, value } of target.parameters) {
    form.append(name, value);
  }
  form.append('file', new Blob([bytes], { type: mimeType }), uploadFilename);

  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new Error(`Upload do stagedTarget nie powiódł się: HTTP ${uploadRes.status}: ${text}`);
  }

  const createData = await graphqlWithRetry({
    store,
    token,
    query: FILE_CREATE,
    variables: {
      files: [{ alt: uploadFilename, contentType: 'FILE', originalSource: target.resourceUrl }],
    },
  });
  const createErrors = createData.fileCreate.userErrors;
  if (createErrors.length > 0) {
    throw new Error(`fileCreate userErrors: ${JSON.stringify(createErrors, null, 2)}`);
  }
  const file = createData.fileCreate.files[0];
  return file.id;
}

async function waitUntilReady({ store, token, fileId }) {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const data = await graphqlWithRetry({ store, token, query: FILE_STATUS_QUERY, variables: { id: fileId } });
    const status = data.node?.fileStatus;
    if (status === 'READY') return;
    if (status === 'FAILED') {
      throw new Error(`Plik ${fileId} zakończył przetwarzanie ze statusem FAILED.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Plik ${fileId} nie osiągnął statusu READY po ${POLL_MAX_ATTEMPTS} próbach (~${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w .env. Sprawdź plik scripts/.env.');
    process.exit(1);
  }

  const dir = path.resolve(args.dir);
  if (!existsSync(dir)) {
    console.error(`Katalog nie istnieje: ${dir}`);
    process.exit(1);
  }

  console.log(args.dryRun ? 'Tryb: DRY-RUN (bez zapisu do Shopify)' : 'Tryb: COMMIT (realny zapis do Shopify)');
  console.log(`Katalog źródłowy: ${dir}`);
  console.log(`Dopasowań do przetworzenia: ${MATCHES.length}`);
  console.log('');

  // --- Rozwiązanie produktów + sprawdzenie plików źródłowych ---
  const notFound = [];
  const missingFiles = [];
  const resolved = [];

  for (const match of MATCHES) {
    const filePath = path.join(dir, match.src);
    if (!existsSync(filePath)) {
      missingFiles.push(match.src);
      continue;
    }
    const data = await graphqlWithRetry({ store, token, query: PRODUCT_QUERY, variables: { handle: match.handle } });
    const product = data.productByHandle;
    if (!product) {
      notFound.push(match.handle);
      continue;
    }
    resolved.push({ ...match, filePath, product });
    await sleep(150);
  }

  if (missingFiles.length > 0) {
    console.log(`--- Pliki źródłowe nieznalezione (${missingFiles.length}) — przerywam, sprawdź --dir ---`);
    for (const f of missingFiles) console.log(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  if (notFound.length > 0) {
    console.log(`--- Produkty nieznalezione w sklepie (${notFound.length}) — przerywam, sprawdź handle w MATCHES ---`);
    for (const h of notFound) console.log(`  - ${h}`);
    process.exitCode = 1;
    return;
  }

  console.log('--- Plan ---');
  for (const item of resolved) {
    const uploadFilename = item.uploadFilename ?? path.basename(item.src);
    const currentValue = item.product.karta?.value ?? null;
    const currentUrl = item.product.karta?.reference?.url ?? null;
    console.log(`\n${item.handle} (${item.product.title})`);
    console.log(`  źródło: ${item.src}`);
    console.log(`  nazwa w bibliotece Shopify: "${uploadFilename}"${uploadFilename !== path.basename(item.src) ? ' [oczyszczona z sufiksu (N)]' : ''}`);
    if (currentValue) {
      console.log(`  custom.karta_produktu: OBECNA WARTOŚĆ = ${currentValue}${currentUrl ? ` (${currentUrl})` : ''} — ZOSTANIE NADPISANA`);
    } else {
      console.log('  custom.karta_produktu: (puste) -> CREATE');
    }
  }

  console.log('');
  console.log('--- Podsumowanie ---');
  console.log(`Do wgrania i podpięcia: ${resolved.length}`);

  if (args.dryRun) {
    console.log('');
    console.log('Dry-run zakończony. Aby zapisać, uruchom z flagą --commit.');
    return;
  }

  // --- Krok 1: upload plików do biblioteki, jeden po drugim, z pollingiem ---
  console.log('');
  console.log('--- Krok 1: wgrywanie plików do biblioteki Shopify ---');
  const uploaded = [];
  for (const item of resolved) {
    const uploadFilename = item.uploadFilename ?? path.basename(item.src);
    console.log(`\n${item.handle}: wgrywam "${uploadFilename}"...`);
    let fileId;
    try {
      fileId = await uploadPdf({ store, token, filePath: item.filePath, uploadFilename });
      console.log(`  fileCreate OK, GID = ${fileId}. Czekam na status READY...`);
      await waitUntilReady({ store, token, fileId });
      console.log('  READY.');
    } catch (err) {
      console.log(`  BŁĄD: ${err.message}`);
      console.log('  Przerywam — pliki po tym punkcie NIE są wgrywane, żaden metafield NIE jest zapisywany.');
      process.exitCode = 1;
      return;
    }
    uploaded.push({ ...item, fileId, uploadFilename });
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // --- Krok 2: metafieldsSet w paczkach po max BATCH_SIZE produktów ---
  console.log('');
  console.log(`--- Krok 2: zapisywanie custom.karta_produktu w paczkach po max ${BATCH_SIZE} produktów ---`);

  const batches = [];
  for (let i = 0; i < uploaded.length; i += BATCH_SIZE) {
    batches.push(uploaded.slice(i, i + BATCH_SIZE));
  }

  const overwritten = uploaded.filter((item) => item.product.karta?.value);
  if (overwritten.length > 0) {
    console.log('\n--- Nadpisywane wartości (stare, dla ewentualnego odzyskania) ---');
    for (const item of overwritten) {
      const url = item.product.karta?.reference?.url ?? '(brak url)';
      console.log(`  ${item.handle}: STARA WARTOŚĆ = ${item.product.karta.value} (${url}) -> ZASTĄPIONA przez "${item.uploadFilename}" (${item.fileId})`);
    }
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const handles = batch.map((x) => x.handle);
    console.log(`\nPaczka ${b + 1}/${batches.length}: ${handles.join(', ')}`);

    const metafields = batch.map((item) => ({
      ownerId: item.product.id,
      namespace: 'custom',
      key: 'karta_produktu',
      type: 'file_reference',
      value: item.fileId,
    }));

    let attempt = 0;
    let json;
    while (true) {
      attempt++;
      json = await shopifyGraphQL({ store, token, query: METAFIELDS_SET_MUTATION, variables: { metafields } });
      if (isThrottled(json)) {
        if (attempt > MAX_RETRIES) throw new Error('Przekroczono limit prób po THROTTLED');
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

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
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log('');
  console.log(`Zakończono. Wgrano i podpięto ${uploaded.length} kart(y) na ${uploaded.length} produktach.`);
  if (overwritten.length > 0) {
    console.log(`Nadpisano ${overwritten.length} istniejącą wartość — patrz "Nadpisywane wartości" wyżej.`);
  }
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exitCode = 1;
});
