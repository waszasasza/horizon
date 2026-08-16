// Wspólny helper GraphQL (Admin API) — wydzielony z import-sensoryka.mjs, reużywalny
// przez inne skrypty (eksport produktów itd.), żeby nie duplikować fetch+retry.

const API_VERSION = '2026-07';

export async function shopifyGraphQL({ store, token, query, variables }) {
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

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(json) {
  const codes = (json.errors ?? []).map((e) => e.extensions?.code);
  return codes.includes('THROTTLED');
}

export async function shopifyGraphQLWithRetry({ store, token, query, variables, maxRetries = 5, baseDelayMs = 1000 }) {
  let attempt = 0;
  while (true) {
    attempt++;
    const json = await shopifyGraphQL({ store, token, query, variables });
    if (isThrottled(json)) {
      if (attempt > maxRetries) throw new Error('Przekroczono limit prób po THROTTLED');
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }
    return json;
  }
}
