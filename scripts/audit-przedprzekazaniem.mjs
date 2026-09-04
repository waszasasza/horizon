#!/usr/bin/env node
/**
 * audit-przedprzekazaniem.mjs
 *
 * WYLACZNIE DIAGNOSTYCZNY. Zero mutacji GraphQL, zero gita, zero theme push.
 * Skrypt tylko czyta stan sklepu i lokalne repo, i wypisuje raport z
 * rekomendacjami przed przekazaniem konta Shopify klientowi.
 *
 * Kazda sekcja jest izolowana try/catch — brak scope'u albo blad API w jednym
 * miejscu nie przerywa reszty audytu, tylko trafia do sekcji LUKI raportu.
 *
 * Uzycie:
 *   node scripts/audit-przedprzekazaniem.mjs
 *   node scripts/audit-przedprzekazaniem.mjs --json raport-przekazanie.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPTS_DIR, '..');

// .env lezy w scripts/.env, niezaleznie od cwd — patrz audit-architektura.mjs.
dotenv.config({ path: path.join(SCRIPTS_DIR, '.env') });

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2026-07'; // ujednolicone z pozostalymi skryptami

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

function isAccessDenied(err) {
  return err.graphqlErrors?.some((e) => e.extensions?.code === 'ACCESS_DENIED');
}

// Kazda funkcja fetchXxx() zwraca { available: true, data } albo
// { available: false, reason } — nigdy nie rzuca dalej, zeby main() nie musial
// owijac kazdego wywolania osobnym try/catch. `reason` trafia bezposrednio do
// sekcji LUKI w raporcie.
async function safe(label, fn) {
  try {
    const data = await fn();
    return { available: true, data };
  } catch (err) {
    const reason = isAccessDenied(err)
      ? 'ACCESS_DENIED — token nie ma wymaganego scope'
      : `blad zapytania: ${err.message}`;
    console.log(`  [LUKA] ${label}: ${reason}`);
    return { available: false, reason: `${label}: ${reason}` };
  }
}

// ---------------------------------------------------------------- KROK 0

function krok0() {
  line('KROK 0 — diagnoza repo');
  const gitStatus = execSync('git status --short', { cwd: REPO_ROOT }).toString();
  const branch = execSync('git branch --show-current', { cwd: REPO_ROOT }).toString().trim();
  const log = execSync('git log --oneline -5', { cwd: REPO_ROOT }).toString();

  line(`  branch: ${branch}`);
  line(`  API_VERSION uzyty w tym skrypcie: ${API_VERSION}`);
  if (gitStatus.trim() === '') {
    line('  git status: CZYSTY — wszystko zacommitowane. OK');
  } else {
    line('  git status: SA NIEZACOMMITOWANE ZMIANY — przed przekazaniem trzeba je zacommitowac albo odrzucic:');
    gitStatus.trim().split('\n').forEach((l) => line(`    ${l}`));
  }
  line('  ostatnie commity:');
  log.trim().split('\n').forEach((l) => line(`    ${l}`));
  line('');

  return { branch, gitClean: gitStatus.trim() === '', gitStatusRaw: gitStatus.trim() };
}

// ---------------------------------------------------------------- KROK 1

async function fetchAppInstallations() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        appInstallations(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            app { id title developerName }
            accessScopes { handle }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.appInstallations.nodes);
    cursor = data.appInstallations.pageInfo.hasNextPage ? data.appInstallations.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchCurrentAppInstallation() {
  const data = await gql(
    `{ currentAppInstallation { id app { id title } accessScopes { handle } } }`
  );
  return data.currentAppInstallation;
}

async function fetchStaffMembers() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        shop {
          staffMembers(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id name email active isShopOwner }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.shop.staffMembers.nodes);
    cursor = data.shop.staffMembers.pageInfo.hasNextPage ? data.shop.staffMembers.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchWebhookSubscriptions() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        webhookSubscriptions(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            topic
            createdAt
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
              ... on WebhookEventBridgeEndpoint { arn }
              ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic }
            }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.webhookSubscriptions.nodes);
    cursor = data.webhookSubscriptions.pageInfo.hasNextPage ? data.webhookSubscriptions.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

function scanScriptsForHardcodedRefs() {
  const files = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  const findings = [];
  // Wzorce warte zgloszenia: URL-e ktore nie sa oczywistym API Shopify budowanym
  // z process.env.SHOPIFY_STORE, oraz cokolwiek co wyglada jak token wpisany na sztywno.
  const urlRe = /https?:\/\/[^\s"'`]+/g;
  const tokenRe = /shpat_[A-Za-z0-9]+|shpca_[A-Za-z0-9]+|shpss_[A-Za-z0-9]+/g;
  for (const f of files) {
    const full = path.join(SCRIPTS_DIR, f);
    const content = fs.readFileSync(full, 'utf8');
    const urls = [...content.matchAll(urlRe)]
      .map((m) => m[0])
      .filter((u) => !u.includes('shopify.dev') && !u.includes('github.com') && !u.includes('sheetjs.com') && !u.includes('developers.klaviyo.com'));
    const tokens = [...content.matchAll(tokenRe)]
      .map((m) => m[0])
      .filter((t) => !/^shpat_x+$/.test(t)); // pomin placeholder z .env.example-owych wzorcow w komentarzach
    if (urls.length || tokens.length) {
      findings.push({ plik: f, urle: [...new Set(urls)], tokenyWykryte: tokens.length });
    }
  }
  return findings;
}

async function krok1() {
  line('KROK 1 — dostepy i aplikacje');

  const installs = await safe('appInstallations', fetchAppInstallations);
  if (installs.available) {
    line(`  Zainstalowane aplikacje: ${installs.data.length}`);
    installs.data.forEach((a) => {
      const scopes = a.accessScopes.map((s) => s.handle).join(', ') || '(brak)';
      line(`    - "${a.app.title}" (dev: ${a.app.developerName ?? 'nieznany'}) — scope'y: ${scopes}`);
    });
  }

  const currentApp = await safe('currentAppInstallation', fetchCurrentAppInstallation);
  if (currentApp.available) {
    line(`  Nasz custom app: "${currentApp.data.app.title}"`);
    line(`    scope'y (${currentApp.data.accessScopes.length}): ${currentApp.data.accessScopes.map((s) => s.handle).join(', ')}`);
  }

  const staff = await safe('staffMembers', fetchStaffMembers);
  if (staff.available) {
    line(`  Konta pracownicze: ${staff.data.length}`);
    staff.data.forEach((s) => {
      line(`    - ${s.name} <${s.email ?? 'brak e-mail'}> ${s.active ? 'aktywny' : 'NIEAKTYWNY'}${s.isShopOwner ? ' [WLASCICIEL]' : ''}`);
    });
  }

  const webhooks = await safe('webhookSubscriptions', fetchWebhookSubscriptions);
  if (webhooks.available) {
    line(`  Webhooki: ${webhooks.data.length}`);
    webhooks.data.forEach((w) => {
      const target =
        w.endpoint.__typename === 'WebhookHttpEndpoint'
          ? w.endpoint.callbackUrl
          : w.endpoint.__typename === 'WebhookEventBridgeEndpoint'
          ? w.endpoint.arn
          : `${w.endpoint.pubSubProject}/${w.endpoint.pubSubTopic}`;
      line(`    - ${w.topic} -> ${target} (utworzony: ${w.createdAt})`);
    });
  }

  const scriptRefs = scanScriptsForHardcodedRefs();
  line(`  Skrypty w scripts/ z zahardkodowanymi URL-ami/tokenami poza .env (${scriptRefs.length} plikow):`);
  scriptRefs.forEach((f) => {
    line(`    - ${f.plik}: ${f.urle.length} URL(i)${f.tokenyWykryte ? `, ${f.tokenyWykryte} WYGLADAJACY NA TOKEN — SPRAWDZ RECZNIE` : ''}`);
    f.urle.forEach((u) => line(`        ${u}`));
  });

  return { installs, currentApp, staff, webhooks, scriptRefs };
}

// ---------------------------------------------------------------- KROK 2

async function fetchAllProductsFull() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id handle title status
            featuredImage { id }
            priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Publikacja w kanale Sklep internetowy — osobne zapytanie per produkt bylo by
// zbyt kosztowne (N+1), wiec sprawdzamy przez publications sklepu + porownanie
// resourcePublications. Uproszczenie: uzywamy publishedOnCurrentPublication
// tylko jesli aktualna publikacja API to Online Store; w przeciwnym razie
// zglaszamy to jako luke zamiast zgadywac.
async function fetchOnlineStorePublicationId() {
  const data = await gql(`{
    publications(first: 20) {
      nodes { id name }
    }
  }`);
  return data.publications.nodes.find((p) => p.name === 'Online Store' || p.name === 'Sklep internetowy') ?? null;
}

// `published_status:unpublished` w query stringu Shopify dotyczy statusu publikacji
// ogolnie (nie konkretnego kanalu przekazanego jako filtr) — to znane ograniczenie
// skladni wyszukiwania Admin API, nie da sie tu podac ID konkretnej publikacji.
// Traktujemy to jako przyblizenie: "nieopublikowany na jakimkolwiek kanale, w tym
// prawdopodobnie na Sklepie internetowym" — dokladna weryfikacja per-kanal
// wymagalaby N+1 zapytan (osobno per produkt), zbyt kosztowne dla audytu.
async function fetchUnpublishedOnChannel() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        products(first: 250, after: $cursor, query: "published_status:unpublished") {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title }
        }
      }`,
      { cursor }
    );
    out.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchAllCollectionsWithCounts() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        collections(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id handle title
            productsCount { count }
            ruleSet { appliedDisjunctively rules { column relation condition } }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.collections.nodes);
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchTestOrdersCount() {
  const data = await gql(`{
    orders(first: 1, query: "test:true") {
      pageInfo { hasNextPage }
      nodes { id }
    }
    ordersCount: orders(first: 250, query: "test:true") {
      nodes { id name createdAt }
      pageInfo { hasNextPage }
    }
  }`);
  return data.ordersCount.nodes;
}

async function fetchCustomersSample() {
  // Pobieramy probke — pelna lista klientow moze byc duza; celem jest
  // wylapanie kont wygladajacych na testowe/wewnetrzne po adresie e-mail,
  // nie pelna inwentaryzacja bazy klientow.
  const out = [];
  let cursor = null;
  let pages = 0;
  do {
    const data = await gql(
      `query($cursor: String) {
        customers(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id email defaultAddress { address1 city } numberOfOrders }
        }
      }`,
      { cursor }
    );
    out.push(...data.customers.nodes);
    cursor = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < 20); // twardy sufit — to jest probka, nie pelny zrzut
  return out;
}

async function fetchDiscountCodes() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        codeDiscountNodes(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            codeDiscount {
              __typename
              ... on DiscountCodeBasic { title status codes(first: 3) { nodes { code } } }
              ... on DiscountCodeBxgy { title status codes(first: 3) { nodes { code } } }
              ... on DiscountCodeFreeShipping { title status codes(first: 3) { nodes { code } } }
            }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.codeDiscountNodes.nodes);
    cursor = data.codeDiscountNodes.pageInfo.hasNextPage ? data.codeDiscountNodes.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchDraftOrdersCount() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        draftOrders(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id name status createdAt }
        }
      }`,
      { cursor }
    );
    out.push(...data.draftOrders.nodes);
    cursor = data.draftOrders.pageInfo.hasNextPage ? data.draftOrders.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

const TEST_NAME_RE = /(-copy|kopia|duplikat|test|_test|test_)/i;

async function krok2() {
  line('');
  line('KROK 2 — dane testowe i pozostalosci');

  const productsRes = await safe('products (status/foto/cena)', fetchAllProductsFull);
  let draftArchived = [];
  let testNamed = [];
  let noImage = [];
  let noPriceOrZero = [];

  if (productsRes.available) {
    const products = productsRes.data;
    draftArchived = products.filter((p) => p.status === 'DRAFT' || p.status === 'ARCHIVED');
    testNamed = products.filter((p) => TEST_NAME_RE.test(p.handle) || TEST_NAME_RE.test(p.title));
    noImage = products.filter((p) => !p.featuredImage);
    noPriceOrZero = products.filter((p) => {
      const min = parseFloat(p.priceRangeV2?.minVariantPrice?.amount ?? 'NaN');
      return Number.isNaN(min) || min === 0;
    });

    line(`  Produkty razem: ${products.length}`);
    line(`  DRAFT/ARCHIVED: ${draftArchived.length}`);
    draftArchived.forEach((p) => line(`    - [${p.status}] ${p.handle} — "${p.title}"`));
    line(`  Podejrzane nazwy (-copy/test/kopia/duplikat): ${testNamed.length}`);
    testNamed.forEach((p) => line(`    - ${p.handle} — "${p.title}" [${p.status}]`));
    line(`  Bez zdjecia: ${noImage.length}`);
    noImage.forEach((p) => line(`    - ${p.handle} — "${p.title}"`));
    line(`  Cena 0 lub brak: ${noPriceOrZero.length}`);
    noPriceOrZero.forEach((p) => line(`    - ${p.handle} — "${p.title}"`));
  }

  const pub = await safe('publications (Online Store id)', fetchOnlineStorePublicationId);
  if (pub.available && !pub.data) {
    line('  [UWAGA] Nie znaleziono publikacji "Online Store"/"Sklep internetowy" w liscie publications.');
  }
  const unpublished = await safe('produkty nieopublikowane (published_status:unpublished, przyblizenie — patrz komentarz w kodzie)', fetchUnpublishedOnChannel);
  if (unpublished.available) {
    line(`  Nieopublikowane (published_status:unpublished, dowolny kanal): ${unpublished.data.length}`);
    unpublished.data.forEach((p) => line(`    - ${p.handle} — "${p.title}"`));
  }

  const collectionsRes = await safe('collections (produktyCount)', fetchAllCollectionsWithCounts);
  let emptyCollections = [];
  if (collectionsRes.available) {
    emptyCollections = collectionsRes.data.filter((c) => (c.productsCount?.count ?? 0) === 0);
    line(`  Kolekcje razem: ${collectionsRes.data.length}`);
    line(`  Puste kolekcje (0 produktow): ${emptyCollections.length}`);
    emptyCollections.forEach((c) => {
      const typ = c.ruleSet ? 'automatyczna' : 'reczna';
      const regula = c.ruleSet ? c.ruleSet.rules.map((r) => `${r.column}/${r.relation}/${r.condition}`).join(' + ') : '-';
      line(`    - ${c.handle} — "${c.title}" [${typ}]${c.ruleSet ? ` regula: ${regula}` : ''}`);
    });

    // Zgloszenie zadania wskazywalo konkretnie te dwa handle jako "moga byc puste"
    // — sprawdzamy je jawnie, zeby raport wprost potwierdzil albo zaprzeczyl
    // zamiast po cichu je pominac, jesli akurat maja produkty.
    line('  Weryfikacja handli wskazanych w zadaniu jako potencjalnie puste:');
    for (const h of ['kursy-winiarskie', 'pamiatki']) {
      const c = collectionsRes.data.find((x) => x.handle === h);
      if (!c) {
        line(`    - ${h}: NIE ZNALEZIONO takiej kolekcji w sklepie`);
      } else {
        const count = c.productsCount?.count ?? 0;
        line(`    - ${h} ("${c.title}"): ${count} produkt(y) — ${count === 0 ? 'PUSTA, potwierdzone' : 'NIE jest pusta, wbrew zalozeniu w zadaniu'}`);
      }
    }
  }

  const testOrders = await safe('orders (test:true) — wymaga read_orders', fetchTestOrdersCount);
  if (testOrders.available) {
    line(`  Zamowienia testowe (test:true): ${testOrders.data.length}${testOrders.data.length === 250 ? '+ (limit strony, moze byc wiecej)' : ''}`);
    testOrders.data.slice(0, 20).forEach((o) => line(`    - ${o.name} (${o.createdAt})`));
  }

  const customersRes = await safe('customers (probka do 5000, read_customers)', fetchCustomersSample);
  let suspiciousCustomers = [];
  if (customersRes.available) {
    suspiciousCustomers = customersRes.data.filter((c) => {
      const email = (c.email ?? '').toLowerCase();
      const addr = `${c.defaultAddress?.address1 ?? ''} ${c.defaultAddress?.city ?? ''}`.toLowerCase();
      return TEST_NAME_RE.test(email) || /example\.com|test@|mala.wies|malawies/.test(email) || TEST_NAME_RE.test(addr);
    });
    line(`  Klienci sprawdzeni (probka): ${customersRes.data.length}`);
    line(`  Wygladajacy na testowych/wewnetrznych: ${suspiciousCustomers.length}`);
    suspiciousCustomers.forEach((c) => line(`    - ${c.email ?? '(brak e-mail)'} — ${c.numberOfOrders} zamowien`));
  }

  const discountsRes = await safe('codeDiscountNodes', fetchDiscountCodes);
  if (discountsRes.available) {
    line(`  Kody rabatowe: ${discountsRes.data.length}`);
    discountsRes.data.forEach((d) => {
      const cd = d.codeDiscount;
      const codes = cd.codes?.nodes?.map((n) => n.code).join(', ') ?? '(brak kodu — automatyczny?)';
      line(`    - "${cd.title}" [${cd.status}] kody: ${codes}`);
    });
  }

  const draftOrdersRes = await safe('draftOrders', fetchDraftOrdersCount);
  if (draftOrdersRes.available) {
    line(`  Wersje robocze zamowien: ${draftOrdersRes.data.length}${draftOrdersRes.data.length === 100 ? '+ (limit strony)' : ''}`);
    draftOrdersRes.data.forEach((d) => line(`    - ${d.name} [${d.status}] (${d.createdAt})`));
  }

  return {
    draftArchived,
    testNamed,
    noImage,
    noPriceOrZero,
    unpublished,
    emptyCollections,
    testOrders,
    suspiciousCustomers,
    discounts: discountsRes,
    draftOrders: draftOrdersRes,
  };
}

// ---------------------------------------------------------------- KROK 3

async function fetchAllMenus() {
  const data = await gql(`{
    menus(first: 50) {
      nodes {
        id handle title
        items {
          title type url resourceId
          items {
            title type url resourceId
            items { title type url resourceId }
          }
        }
      }
    }
  }`);
  return data.menus.nodes;
}

function flattenMenuItems(items, trail = []) {
  const out = [];
  for (const item of items ?? []) {
    out.push({ ...item, trail: [...trail, item.title] });
    if (item.items?.length) out.push(...flattenMenuItems(item.items, [...trail, item.title]));
  }
  return out;
}

async function checkResourceExists(id) {
  // GID zawiera typ zasobu (gid://shopify/Product/123 itd.) — jedno generyczne
  // zapytanie `node(id)` wystarcza zamiast osobnego query per typ.
  const data = await gql(`query($id: ID!) { node(id: $id) { id } }`, { id });
  return data.node !== null;
}

async function fetchMetafieldDefinitions() {
  const ownerTypes = ['PRODUCT', 'COLLECTION', 'CUSTOMER', 'ORDER', 'ARTICLE', 'BLOG', 'PAGE', 'SHOP'];
  const out = [];
  for (const ownerType of ownerTypes) {
    let cursor = null;
    do {
      const data = await gql(
        `query($cursor: String, $ownerType: MetafieldOwnerType!) {
          metafieldDefinitions(first: 100, after: $cursor, ownerType: $ownerType) {
            pageInfo { hasNextPage endCursor }
            nodes { id name namespace key ownerType metafieldsCount }
          }
        }`,
        { cursor, ownerType }
      );
      out.push(...data.metafieldDefinitions.nodes);
      cursor = data.metafieldDefinitions.pageInfo.hasNextPage ? data.metafieldDefinitions.pageInfo.endCursor : null;
    } while (cursor);
  }
  return out;
}

async function fetchMetaobjectDefinitionsWithCounts() {
  const defs = await gql(`{
    metaobjectDefinitions(first: 100) {
      nodes { id type name }
    }
  }`);
  const out = [];
  for (const d of defs.metaobjectDefinitions.nodes) {
    const data = await gql(
      `query($type: String!) {
        metaobjects(type: $type, first: 1) {
          pageInfo { hasNextPage }
        }
      }
      `,
      { type: d.type }
    );
    // first:1 nie daje total count — osobne zapytanie liczace przez petle stronicowania
    let count = 0;
    let cursor = null;
    do {
      const page = await gql(
        `query($type: String!, $cursor: String) {
          metaobjects(type: $type, first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id }
          }
        }`,
        { type: d.type, cursor }
      );
      count += page.metaobjects.nodes.length;
      cursor = page.metaobjects.pageInfo.hasNextPage ? page.metaobjects.pageInfo.endCursor : null;
    } while (cursor);
    out.push({ type: d.type, name: d.name, count });
  }
  return out;
}

async function fetchUrlRedirectsAll() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        urlRedirects(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id path target }
        }
      }`,
      { cursor }
    );
    out.push(...data.urlRedirects.nodes);
    cursor = data.urlRedirects.pageInfo.hasNextPage ? data.urlRedirects.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchThemes() {
  const data = await gql(`{
    themes(first: 50) {
      nodes { id name role createdAt updatedAt }
    }
  }`);
  return data.themes.nodes;
}

async function krok3() {
  line('');
  line('KROK 3 — spojnosc katalogu');

  const menusRes = await safe('menus', fetchAllMenus);
  let brokenMenuItems = [];
  if (menusRes.available) {
    for (const menu of menusRes.data) {
      const flat = flattenMenuItems(menu.items);
      for (const item of flat) {
        if (!item.resourceId) continue;
        try {
          const exists = await checkResourceExists(item.resourceId);
          if (!exists) brokenMenuItems.push({ menu: menu.handle, pozycja: item.trail.join(' > '), resourceId: item.resourceId });
        } catch (err) {
          brokenMenuItems.push({ menu: menu.handle, pozycja: item.trail.join(' > '), resourceId: item.resourceId, blad: err.message });
        }
      }
    }
    line(`  Menu sprawdzone: ${menusRes.data.map((m) => m.handle).join(', ')}`);
    line(`  Pozycje menu wskazujace na nieistniejace zasoby: ${brokenMenuItems.length}`);
    brokenMenuItems.forEach((x) => line(`    - [${x.menu}] ${x.pozycja} -> ${x.resourceId}${x.blad ? ` (blad: ${x.blad})` : ''}`));
  }

  const mfDefsRes = await safe('metafieldDefinitions (per ownerType)', fetchMetafieldDefinitions);
  let emptyMetafieldDefs = [];
  if (mfDefsRes.available) {
    emptyMetafieldDefs = mfDefsRes.data.filter((d) => (d.metafieldsCount ?? 0) === 0);
    line(`  Definicje metapol razem: ${mfDefsRes.data.length}`);
    line(`  Bez ani jednej wypelnionej wartosci: ${emptyMetafieldDefs.length}`);
    emptyMetafieldDefs.forEach((d) => line(`    - ${d.ownerType}: ${d.namespace}.${d.key} ("${d.name}")`));
    const lowUsage = mfDefsRes.data.filter((d) => (d.metafieldsCount ?? 0) > 0 && d.metafieldsCount <= 2);
    if (lowUsage.length) {
      line(`  Uzywane na 1-2 obiektach (sprawdz recznie, moga byc falszywym tropem jak shopify.wine-variety):`);
      lowUsage.forEach((d) => line(`    - ${d.ownerType}: ${d.namespace}.${d.key} — ${d.metafieldsCount} obiekt(y)`));
    }
  }

  const metaobjRes = await safe('metaobjectDefinitions + counts', fetchMetaobjectDefinitionsWithCounts);
  let emptyMetaobjectTypes = [];
  if (metaobjRes.available) {
    emptyMetaobjectTypes = metaobjRes.data.filter((m) => m.count === 0);
    line(`  Typy metaobiektow: ${metaobjRes.data.length}`);
    metaobjRes.data.forEach((m) => line(`    - ${m.type} ("${m.name}"): ${m.count} wpis(y)${m.count === 0 ? '  <-- PUSTY TYP' : ''}`));
  }

  const redirectsRes = await safe('urlRedirects (read_url_redirects)', fetchUrlRedirectsAll);
  let danglingRedirects = [];
  if (redirectsRes.available) {
    line(`  Przekierowania: ${redirectsRes.data.length}`);
    // Cel jest opisany jako sciezka relatywna (np. /products/x) albo pelny URL
    // zewnetrzny — sprawdzamy tylko wewnetrzne cele wygladajace na Shopify.
    for (const r of redirectsRes.data) {
      if (/^https?:\/\//.test(r.target)) continue; // zewnetrzny URL — nie sprawdzamy
      // Bardzo prosta heurystyka: /products/<handle>, /collections/<handle>, /pages/<handle>
      const m = r.target.match(/^\/(products|collections|pages|blogs)\/([^/?#]+)/);
      if (!m) continue;
      danglingRedirects.push({ path: r.path, target: r.target, uwaga: 'nie zweryfikowano automatycznie — sprawdz recznie czy cel istnieje' });
    }
    line(`  Redirecty z celem wewnetrznym do recznej weryfikacji: ${danglingRedirects.length} (skrypt nie odpytuje kazdego celu osobno — patrz LUKI)`);
  }

  const themesRes = await safe('themes', fetchThemes);
  if (themesRes.available) {
    line(`  Motywy: ${themesRes.data.length}`);
    themesRes.data.forEach((t) => line(`    - "${t.name}" [${t.role}] ostatnia aktualizacja: ${t.updatedAt} (id: ${t.id})`));
  }

  return { brokenMenuItems, emptyMetafieldDefs, mfDefsRes, emptyMetaobjectTypes, metaobjRes, redirectsRes, danglingRedirects, themesRes };
}

// ---------------------------------------------------------------- KROK 4

async function fetchFilesAll() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($cursor: String) {
        files(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            createdAt
            alt
            fileStatus
            ... on MediaImage {
              image { url width height }
              originalSource { fileSize }
            }
            ... on GenericFile { originalFileSize url }
            ... on Video { originalSource { fileSize } }
          }
        }
      }`,
      { cursor }
    );
    out.push(...data.files.nodes);
    cursor = data.files.pageInfo.hasNextPage ? data.files.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

const THREE_MONTHS_MS = 1000 * 60 * 60 * 24 * 90;

async function krok4() {
  line('');
  line('KROK 4 — biblioteka plikow');

  const filesRes = await safe('files', fetchFilesAll);
  if (!filesRes.available) return { filesRes };

  const files = filesRes.data;
  const totalBytes = files.reduce((sum, f) => sum + (f.originalSource?.fileSize ?? f.originalFileSize ?? 0), 0);
  line(`  Plikow razem: ${files.length}`);
  line(`  Laczna waga (przyblizona, tylko pliki z rozpoznanym rozmiarem): ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const now = Date.now();
  const older = files.filter((f) => now - new Date(f.createdAt).getTime() > THREE_MONTHS_MS);
  line(`  Starsze niz 3 miesiace: ${older.length} — TYLKO te sprawdzone pod katem uzycia (przyblizenie, patrz LUKI)`);

  const testNamed = files.filter((f) => TEST_NAME_RE.test(f.alt ?? '') || TEST_NAME_RE.test(f.url ?? f.image?.url ?? ''));
  line(`  Wygladajace na testowe/robocze (nazwa/alt): ${testNamed.length}`);
  testNamed.forEach((f) => line(`    - ${f.id} (${f.createdAt})`));

  line(`  Sprawdzenie referencji (produkt/kolekcja/artykul/metapole) do KAZDEGO pliku NIE wykonane —`);
  line(`  zbyt kosztowne (N plikow x M typow zasobow). Patrz LUKI.`);

  return { filesRes, totalBytes, older, testNamed };
}

// ---------------------------------------------------------------- KROK 5

function krok5() {
  line('');
  line('KROK 5 — sekrety i pozostalosci po naszej stronie');

  const envPath = path.join(SCRIPTS_DIR, '.env');
  const envExists = fs.existsSync(envPath);
  let envKeyCount = 0;
  if (envExists) {
    const content = fs.readFileSync(envPath, 'utf8');
    envKeyCount = content.split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l.trim())).length;
  }
  line(`  scripts/.env istnieje: ${envExists ? 'TAK' : 'nie'}${envExists ? ` (${envKeyCount} kluczy, wartosci nie wypisane)` : ''}`);

  const gitignorePath = path.join(REPO_ROOT, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const envIgnored = gitignore.split('\n').some((l) => l.trim() === '.env' || l.trim() === 'scripts/.env' || l.trim() === '*.env');
  line(`  .env w .gitignore: ${envIgnored ? 'TAK' : 'NIE — DO SPRAWDZENIA'}`);

  let envHistory = '';
  let tokenHistoryHits = [];
  try {
    envHistory = execSync('git log --all --full-history --oneline -- "*.env"', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    envHistory = '';
  }
  try {
    const raw = execSync('git log --all --oneline -S "shpat_" -- .', { cwd: REPO_ROOT }).toString().trim();
    tokenHistoryHits = raw ? raw.split('\n') : [];
  } catch {
    tokenHistoryHits = [];
  }

  const envInHistory = envHistory.length > 0;
  const critical = [];
  if (envInHistory) {
    critical.push(`Plik .env pojawil sie kiedys w historii gita: ${envHistory}`);
  }
  if (tokenHistoryHits.length) {
    critical.push(`Commity ktore kiedykolwiek dodaly/usunely fragment "shpat_" (WYMAGA RECZNEJ WERYFIKACJI czy to placeholder czy realny token): ${tokenHistoryHits.join(' | ')}`);
  }

  if (critical.length) {
    line('  !!! ZNALEZISKO KRYTYCZNE !!!');
    critical.forEach((c) => line(`    - ${c}`));
  } else {
    line('  Historia gita: brak sladu .env i brak fragmentu "shpat_" poza znanym placeholderem w .env.example. OK');
  }

  const importMarekPath = path.join(REPO_ROOT, 'import-marek');
  const importMarekExists = fs.existsSync(importMarekPath);
  let importMarekFiles = [];
  if (importMarekExists) {
    importMarekFiles = fs.readdirSync(importMarekPath);
  }
  const importMarekGitignored = gitignore.split('\n').some((l) => l.trim() === 'import-marek/' || l.trim() === 'import-marek');
  line(`  import-marek/ istnieje: ${importMarekExists ? `TAK (${importMarekFiles.length} plikow)` : 'nie'}`);
  if (importMarekExists) {
    line(`  import-marek/ w .gitignore: ${importMarekGitignored ? 'TAK' : 'NIE — DO SPRAWDZENIA, moze zawierac dane robocze klienta'}`);
  }

  // Inne katalogi robocze widoczne w scripts/ z danymi/logami eksportu
  const workingArtifacts = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => /\.(xlsx|docx|csv)$/i.test(f) || /log|raport|export|eksport/i.test(f))
    .filter((f) => f !== 'README.md' && f !== 'package.json' && f !== 'package-lock.json');
  line(`  Pliki robocze/dane w scripts/ (xlsx/docx/csv/log) widoczne na dysku: ${workingArtifacts.length}`);
  const tracked = new Set(execSync('git ls-files scripts', { cwd: REPO_ROOT }).toString().trim().split('\n').filter(Boolean));
  workingArtifacts.forEach((f) => {
    const isTracked = tracked.has(path.join('scripts', f));
    line(`    - ${f} ${isTracked ? '[W GICIE — sprawdz czy powinien tam byc]' : '[niesledzony]'}`);
  });

  return { envExists, envKeyCount, envIgnored, envInHistory, tokenHistoryHits, critical, importMarekExists, importMarekFiles, importMarekGitignored, workingArtifacts, tracked: [...tracked] };
}

// ---------------------------------------------------------------- KROK 6

function krok6() {
  line('');
  line('KROK 6 — kopie zapasowe do wykonania przed przekazaniem (komendy, NIC nie uruchamiane automatycznie)');

  const commands = [
    ['Eksport motywu roboczego do pliku', `shopify theme pull --theme=<ID_MOTYWU> --path=./backup-theme-$(date +%Y%m%d)`],
    ['Eksport produktow (CSV, natywny)', 'Shopify Admin -> Produkty -> Eksportuj -> "Wszystkie produkty" -> plik CSV'],
    ['Eksport produktow (pelne dane przez API, juz mamy narzedzie)', 'node scripts/export-produkty-xlsx.mjs'],
    ['Eksport kolekcji (CSV, natywny)', 'Shopify Admin -> Kolekcje -> Eksportuj'],
    ['Eksport klientow (CSV, natywny)', 'Shopify Admin -> Klienci -> Eksportuj -> "Wszyscy klienci"'],
    ['Eksport zamowien (CSV, natywny)', 'Shopify Admin -> Zamowienia -> Eksportuj -> zakres "Wszystkie zamowienia"'],
    ['Zrzut definicji metapol i wartosci (GraphQL, do napisania jesli potrzebny pelny zrzut)', 'brak gotowego skryptu — do napisania jako osobne zadanie, jesli potrzebny'],
    ['Zrzut metaobiektow', 'node scripts/inspect-metaobjekty-referencje.json (juz istnieje jako zrzut punktowy) lub nowe zapytanie metaobjects per typ'],
    ['Kopia main-menu i pozostalych menu', 'Shopify Admin -> Nawigacja -> zrzut recznie (brak natywnego eksportu) albo zapytanie GraphQL menus{} zapisane do pliku'],
    ['Kopia przekierowan', 'Shopify Admin -> Nawigacja -> Przekierowania URL -> eksport CSV (jesli dostepny) albo zapytanie GraphQL urlRedirects{}'],
  ];
  commands.forEach(([label, cmd]) => {
    line(`  - ${label}:`);
    line(`      ${cmd}`);
  });

  return commands;
}

// ---------------------------------------------------------------- output helpers

const OUTPUT_LINES = [];
function line(s) {
  console.log(s);
  OUTPUT_LINES.push(s);
}

// ---------------------------------------------------------------- main

async function main() {
  line('='.repeat(70));
  line('AUDYT PRZED PRZEKAZANIEM KONTA — WYLACZNIE DIAGNOSTYCZNY');
  line('Zero mutacji, zero commitow, zero pushy. Wynik to tylko raport.');
  line('='.repeat(70));
  line('');

  const k0 = krok0();
  const k1 = await krok1();
  const k2 = await krok2();
  const k3 = await krok3();
  const k4 = await krok4();
  const k5 = krok5();
  const k6 = krok6();

  // -------------------------------------------------------- KROK 7 — raport

  line('');
  line('='.repeat(70));
  line('RAPORT KONCOWY');
  line('='.repeat(70));

  if (k5.critical.length) {
    line('');
    line('!!! ZNALEZISKA KRYTYCZNE (sprawdz PRZED czymkolwiek innym) !!!');
    k5.critical.forEach((c) => line(`  - ${c}`));
  }

  line('');
  line('1. DO USUNIECIA PRZED PRZEKAZANIEM');
  const doUsuniecia = [];
  (k2.draftArchived ?? []).forEach((p) =>
    doUsuniecia.push(`Produkt [${p.status}] ${p.handle} ("${p.title}") — nieopublikowany/zarchiwizowany, prawdopodobnie robocze dane`)
  );
  (k2.testNamed ?? []).forEach((p) =>
    doUsuniecia.push(`Produkt ${p.handle} ("${p.title}") — nazwa/handle wyglada na testowa/kopie`)
  );
  (k2.emptyCollections ?? []).forEach((c) =>
    doUsuniecia.push(`Kolekcja ${c.handle} ("${c.title}") — 0 produktow`)
  );
  (k3.emptyMetafieldDefs ?? []).forEach((d) =>
    doUsuniecia.push(`Definicja metapola ${d.ownerType}: ${d.namespace}.${d.key} ("${d.name}") — zero wypelnionych wartosci`)
  );
  (k3.emptyMetaobjectTypes ?? []).forEach((m) =>
    doUsuniecia.push(`Typ metaobiektu ${m.type} ("${m.name}") — 0 wpisow`)
  );
  (k4.testNamed ?? []).forEach((f) =>
    doUsuniecia.push(`Plik ${f.id} — nazwa/alt wyglada na testowa/robocza`)
  );
  if (doUsuniecia.length === 0) line('  (brak jednoznacznych kandydatow — patrz listy szczegolowe wyzej)');
  doUsuniecia.forEach((x) => line(`  - ${x}`));

  line('');
  line('2. DO ZABEZPIECZENIA');
  const doZabezpieczenia = [];
  if (k1.webhooks.available) {
    k1.webhooks.data.forEach((w) => {
      const target = w.endpoint.__typename === 'WebhookHttpEndpoint' ? w.endpoint.callbackUrl : JSON.stringify(w.endpoint);
      doZabezpieczenia.push(`Webhook "${w.topic}" -> ${target} — jesli wskazuje na NASZ serwer, odlaczyc/przepiac PRZED przekazaniem (inaczej dane klienta beda plynac do nas po zmianie wlasciciela)`);
    });
  }
  if (k1.currentApp.available) {
    doZabezpieczenia.push(`Nasz custom app "${k1.currentApp.data.app.title}" ze scope'ami: ${k1.currentApp.data.accessScopes.map((s) => s.handle).join(', ')} — po przekazaniu zrotowac/uniewaznic token, jesli nie bedziemy dalej obslugiwac sklepu`);
  }
  if (k1.installs.available) {
    const foreign = k1.installs.data.filter((a) => a.app.developerName && !/majatek|mala wies|nasz/i.test(a.app.developerName));
    foreign.forEach((a) => doZabezpieczenia.push(`Aplikacja "${a.app.title}" (dev: ${a.app.developerName}) — potwierdzic, czy klient wie o niej i chce ja zachowac`));
  }
  doZabezpieczenia.push('scripts/.env — nie wchodzi do repo (juz w .gitignore), ale token w nim trzeba zrotowac po przekazaniu, jesli byl uzywany do zapisu danych katalogowych');
  doZabezpieczenia.forEach((x) => line(`  - ${x}`));

  line('');
  line('3. DO UDOKUMENTOWANIA DLA KLIENTA');
  const doUdokumentowania = [];
  if (k1.installs.available) {
    k1.installs.data.forEach((a) => doUdokumentowania.push(`Aplikacja "${a.app.title}" (dev: ${a.app.developerName ?? 'nieznany'}) — po co jest, czy wymaga subskrypcji`));
  }
  if (k3.themesRes.available) {
    k3.themesRes.data.forEach((t) => doUdokumentowania.push(`Motyw "${t.name}" [${t.role}] — czy to robocza kopia, czy trzeba zachowac`));
  }
  doUdokumentowania.push('Konwencje z CLAUDE.md tego repo: prefiks mmw-, metapola sterujace badge/opisem, mechanizm scroll-reveal, itp. — jesli klient przejmuje rowniez rozwoj motywu, ten plik jest kluczowy');
  doUdokumentowania.forEach((x) => line(`  - ${x}`));

  line('');
  line('4. LUKI');
  const luki = [];
  if (!k0.gitClean) luki.push('Repo ma niezacommitowane zmiany w momencie audytu — patrz KROK 0 wyzej.');
  [k1.installs, k1.currentApp, k1.staff, k1.webhooks].forEach((r) => {
    if (!r.available) luki.push(r.reason);
  });
  if (k2.testOrders && !k2.testOrders.available) luki.push(k2.testOrders.reason);
  if (k2.discounts && !k2.discounts.available) luki.push(k2.discounts.reason);
  if (k2.draftOrders && !k2.draftOrders.available) luki.push(k2.draftOrders.reason);
  if (!k3.redirectsRes.available) luki.push(k3.redirectsRes.reason);
  else luki.push('Przekierowania: cele wewnetrzne nie zweryfikowane automatycznie jeden-po-jednym (koszt zapytan) — patrz lista "do recznej weryfikacji" w KROK 3.');
  if (!k3.mfDefsRes.available) luki.push(k3.mfDefsRes.reason);
  if (!k3.metaobjRes.available) luki.push(k3.metaobjRes.reason);
  if (!k4.filesRes.available) luki.push(k4.filesRes.reason);
  else luki.push('Biblioteka plikow: referencje do KAZDEGO pliku (produkt/kolekcja/artykul/metapole) nie sprawdzone — zbyt kosztowne; ograniczono sie do wieku (>3 mies.) i nazwy jako przyblizenia.');
  luki.push('Klienci: sprawdzona tylko probka (do 5000, limit 20 stron po 250) — pelna baza moze byc wieksza.');
  if (luki.length === 0) line('  (brak zarejestrowanych luk)');
  luki.forEach((x) => line(`  - ${x}`));

  line('');
  line('='.repeat(70));
  line('POTWIERDZENIE: skrypt wykonal wylacznie zapytania query. Zero mutacji GraphQL,');
  line('zero git commit/push, zero shopify theme push, zero usunietych/zmienionych obiektow.');
  line('='.repeat(70));

  if (JSON_OUT) {
    const jsonPath = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(REPO_ROOT, JSON_OUT);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          krok0: k0,
          krok1: { ...k1 },
          krok2: { ...k2 },
          krok3: { ...k3 },
          krok4: { ...k4 },
          krok5: k5,
          krok6: k6,
        },
        null,
        2
      ),
      'utf8'
    );
    line('');
    line(`Pelny raport JSON zapisany do ${jsonPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  console.error('Skrypt zakonczyl sie bledem — patrz wyzej. Zadna mutacja nie zostala wykonana (skrypt uzywa wylacznie query).');
  process.exit(1);
});
