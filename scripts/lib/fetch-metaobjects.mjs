// Moduł wielokrotnego użytku: pełny odczyt istniejących wpisów danego typu metaobiektu
// (paginacja). Używane do zrzutów stanu PRZED/PO w import-sensoryka.mjs oraz do
// introspekcji w inspect-sensoryka.mjs.

const QUERY = /* GraphQL */ `
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

/**
 * @param {object} params
 * @param {string} params.store
 * @param {string} params.token
 * @param {(args: object) => Promise<any>} params.graphql
 * @param {string} params.type
 * @returns {Promise<Array<{id: string, handle: string, displayName: string, fields: Array<{key: string, value: string, type: string}>}>>}
 */
export async function fetchAllMetaobjects({ store, token, graphql, type }) {
  let cursor = null;
  const all = [];
  while (true) {
    const json = await graphql({ store, token, query: QUERY, variables: { type, cursor } });
    if (json.errors) throw new Error(`fetchAllMetaobjects(${type}): ${JSON.stringify(json.errors)}`);
    all.push(...json.data.metaobjects.nodes);
    if (!json.data.metaobjects.pageInfo.hasNextPage) break;
    cursor = json.data.metaobjects.pageInfo.endCursor;
  }
  return all;
}
