// Moduł wielokrotnego użytku: rozwiązywanie handle → GID metaobiektu przez query
// (nigdy hardkodowane GID-y). Używane przez import-sensoryka.mjs (skale → poziomy)
// i docelowo przez przyszły etap per-produktowy (custom.skale), stąd osobny plik.

const QUERY = /* GraphQL */ `
  query MmwMetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      handle
      type
    }
  }
`;

/**
 * @param {object} params
 * @param {string} params.store
 * @param {string} params.token
 * @param {(args: { store: string, token: string, query: string, variables: object }) => Promise<any>} params.graphql
 * @param {string} params.type - typ definicji metaobiektu (np. "skala_sensoryczna")
 * @param {string} params.handle
 * @returns {Promise<string|null>} GID albo null, jeśli wpis nie istnieje
 */
export async function resolveMetaobjectGid({ store, token, graphql, type, handle }) {
  const json = await graphql({ store, token, query: QUERY, variables: { handle: { type, handle } } });
  if (json.errors) throw new Error(`resolveMetaobjectGid(${type}:${handle}): ${JSON.stringify(json.errors)}`);
  return json.data?.metaobjectByHandle?.id ?? null;
}

/**
 * Rozwiązuje wiele handle naraz (sekwencyjnie, żeby nie palić rate limitu).
 * @returns {Promise<Map<string, string>>} handle -> GID (pomija te, których nie znaleziono)
 */
export async function resolveManyMetaobjectGids({ store, token, graphql, type, handles }) {
  const map = new Map();
  for (const handle of handles) {
    const gid = await resolveMetaobjectGid({ store, token, graphql, type, handle });
    if (gid) map.set(handle, gid);
  }
  return map;
}
