#!/usr/bin/env node
// Import 8 artykułów na bloga "news" z ARTUKUŁY_NA_BLOGA.docx (scripts/artykuly-blog.docx)
// przez Admin API. Ten sam kształt co assign-pairings.mjs / import-wina.mjs: dry-run
// domyślny, --commit do zapisu.
//
// Treść wchodzi TAKA, JAKA JEST — bez poprawek literówek, bez uzupełniania placeholderów
// [DO UZUPEŁNIENIA] własnym tekstem. Konwersja HTML: akapity -> <p>, rozpoznane nagłówki
// -> <h2> (heurystyka zaakceptowana w Kroku 0 — patrz CLAUDE.md / raport), tabele -> <table>.
// Artykuły tworzone jako published: false (isPublished: false) — klient przegląda przed
// publikacją.
//
// Zawsze (dry-run i --commit) generuje braki-artykuly.md na Pulpicie (~/Desktop) — drugi
// deliverable, dla klienta, celowo POZA repo/scripts/, niezależny od zapisu do Shopify.
//
// Użycie:
//   node import-blog-articles.mjs            (dry-run, domyślnie)
//   node import-blog-articles.mjs --commit    (realny zapis, published: false)

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { XMLParser } from 'fast-xml-parser';

dotenv.config();

const API_VERSION = '2026-01';
const DOCX_FILE = 'artykuly-blog.docx';
const BLOG_ID = 'gid://shopify/Blog/121075204429'; // "news" — jedyny blog, potwierdzone Admin API
const AUTHOR_NAME = 'Majątek Mała Wieś';
// Deliverable dla klienta — celowo POZA scripts/, żeby nie wylądował w commicie razem z kodem.
const GAPS_FILE = path.join(process.env.HOME ?? '.', 'Desktop', 'braki-artykuly.md');

const RATE_LIMIT_DELAY_MS = 550;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

// --- CLI args ---
function parseArgs(argv) {
  const args = { dryRun: true };
  for (const arg of argv) {
    if (arg === '--commit') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

// --- docx XML parsing (WordprocessingML: word/document.xml) ---
function findChild(node, tag) {
  if (!Array.isArray(node)) return null;
  for (const item of node) if (item[tag] !== undefined) return item;
  return null;
}
function findAllChildren(node, tag) {
  if (!Array.isArray(node)) return [];
  return node.filter((item) => item[tag] !== undefined);
}
function paragraphInfo(pChildren) {
  const runs = [];
  const wRuns = findAllChildren(pChildren, 'w:r');
  for (const run of wRuns) {
    const runChildren = run['w:r'];
    const rPr = findChild(runChildren, 'w:rPr');
    let isBold = false;
    if (rPr) {
      const b = findChild(rPr['w:rPr'], 'w:b');
      if (b) {
        const val = b['w:b']?.[0]?.['#text'] ?? b[':@']?.['@_w:val'];
        isBold = val === undefined || val === 'true' || val === '1';
      }
    }
    const tNodes = findAllChildren(runChildren, 'w:t');
    let runText = '';
    for (const tNode of tNodes) runText += tNode['w:t']?.[0]?.['#text'] ?? '';
    if (runText.length > 0) runs.push({ text: runText, bold: isBold });
  }
  // Word często dzieli jeden wizualny "pogrubiony fragment" na kilka sąsiednich w:r
  // o tym samym stanie bold (artefakt edycji/sprawdzania pisowni) — scalamy sąsiednie
  // runy o identycznym bold w jeden, żeby nie generować <strong>a</strong><strong>b</strong>
  // zamiast <strong>ab</strong>. Nie zmienia treści ani granic bold/nonbold używanych
  // przez isGlued (te zależą tylko od PRZEJŚĆ między stanami, których scalanie nie rusza).
  const mergedRuns = [];
  for (const run of runs) {
    const last = mergedRuns[mergedRuns.length - 1];
    if (last && last.bold === run.bold) last.text += run.text;
    else mergedRuns.push({ ...run });
  }
  const text = mergedRuns.map((r) => r.text).join('');
  return { text, runs: mergedRuns };
}
function tableToRows(tblChildren) {
  const rows = findAllChildren(tblChildren, 'w:tr');
  return rows.map((row) =>
    findAllChildren(row['w:tr'], 'w:tc').map((cell) =>
      findAllChildren(cell['w:tc'], 'w:p').map((p) => paragraphInfo(p['w:p']).text).join(' ').trim()
    )
  );
}
function isGlued(runs) {
  for (let i = 0; i < runs.length - 1; i++) {
    const a = runs[i];
    const b = runs[i + 1];
    if (a.bold !== b.bold) {
      const lastCharA = a.text.slice(-1);
      const firstCharB = b.text.slice(0, 1);
      if (lastCharA && firstCharB && !/\s/.test(lastCharA) && !/\s/.test(firstCharB)) return true;
    }
  }
  return false;
}

// Zaakceptowane w Kroku 0 (patrz raport w rozmowie / CLAUDE.md): podpis/etykieta mapki,
// której nigdy nie było w dokumencie (brak word/media/ w całym .docx) — pomijane
// z treści, logowane jako brak.
const MANUAL_EXCLUDE = new Set([
  'Pałac Mała Wieśznajduję się40 min od Warszawy',
  'Pinezka',
]);
const MAX_HEADING_LEN = 60;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// .docx to zip — rozpakowuje word/document.xml do tymczasowego katalogu systemowego
// (nie w scripts/, żeby nie zostawiać artefaktów obok kodu) i sprząta po sobie zaraz po
// odczycie. Wymaga `unzip` w PATH (natywne na macOS/Linux) — brak dodatkowej zależności
// npm tylko po to, żeby raz na jakiś czas rozpakować jeden plik XML z archiwum.
function extractDocumentXml(docxPath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'mmw-docx-'));
  try {
    execFileSync('unzip', ['-o', docxPath, 'word/document.xml', '-d', tmpDir], { stdio: 'pipe' });
    return readFileSync(path.join(tmpDir, 'word/document.xml'), 'utf8');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseDocx() {
  if (!existsSync(DOCX_FILE)) {
    throw new Error(`Brak ${DOCX_FILE} w bieżącym katalogu.`);
  }
  const xml = extractDocumentXml(DOCX_FILE);
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const body = findChild(doc, 'w:document')['w:document'];
  const bodyChildren = findChild(body, 'w:body')['w:body'];

  const sequence = [];
  for (const node of bodyChildren) {
    if (node['w:p'] !== undefined) sequence.push({ type: 'p', ...paragraphInfo(node['w:p']) });
    else if (node['w:tbl'] !== undefined) sequence.push({ type: 'table', rows: tableToRows(node['w:tbl']) });
  }

  const articleMarkerRe = /^Artykuł\s*(\d+)$/;
  const articles = [];
  let current = null;
  for (const item of sequence) {
    if (item.type === 'p') {
      const m = item.text.trim().match(articleMarkerRe);
      if (m) {
        current = { num: Number(m[1]), items: [] };
        articles.push(current);
        continue;
      }
    }
    if (current) current.items.push(item);
  }
  return articles;
}

const FIELD_LABELS = ['Tytuł', 'Url', 'SEO title', 'Meta description', 'Zajawka', 'Tagi', 'Linki wewnętrzne', 'CTA'];
function parseField(text) {
  const m = text.match(/^([A-Za-złąćęńóśźż ]+?)\s*:\s*(.*)$/su);
  if (!m) return null;
  const label = m[1].trim();
  if (!FIELD_LABELS.includes(label)) return null;
  return { label, value: m[2] };
}

/**
 * Buduje jeden artykuł: metadane + HTML treści + wpisy do braków.
 */
function buildArticle(art) {
  const fields = {};
  let bodyStartIdx = -1;
  for (let i = 0; i < art.items.length; i++) {
    const item = art.items[i];
    if (item.type !== 'p') continue;
    const trimmed = item.text.trim();
    if (trimmed === 'Treść:') {
      bodyStartIdx = i + 1;
      break;
    }
    const field = parseField(trimmed);
    if (field) {
      if (!fields[field.label]) fields[field.label] = [];
      fields[field.label].push(field.value);
    }
  }
  const get = (label) => (fields[label] ? fields[label].join(' ') : '');

  const title = get('Tytuł').trim();
  const handle = get('Url').trim();
  const seoTitle = get('SEO title').trim();
  const metaDescription = get('Meta description').trim();
  const summary = get('Zajawka').trim();
  const tags = get('Tagi')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const linkiWewnetrzne = get('Linki wewnętrzne').trim();
  const ctaMetadata = get('CTA').trim();

  const gaps = [];

  // Metadana CTA (nad "Treść:") NIE jest wstawiana do treści (notatka redakcyjna) —
  // ale jeśli sama zawiera placeholder ("TUTAJ URL..."), to nadal jest realnym brakiem
  // do zgłoszenia, tylko poza treścią artykułu, nie w jego numerowanych akapitach.
  if (/TUTAJ\s+URL/iu.test(ctaMetadata)) {
    gaps.push({ paragraph: null, type: 'cta-metadana-z-placeholderem', quote: ctaMetadata });
  }

  const bodyItems = art.items.slice(bodyStartIdx);
  let lastNonBlankIdx = -1;
  for (let i = bodyItems.length - 1; i >= 0; i--) {
    const t = bodyItems[i].type === 'p' ? bodyItems[i].text.trim() : '';
    if (t !== '' && !/^(Link|CTA)\s*:/u.test(t)) {
      lastNonBlankIdx = i;
      break;
    }
  }

  const htmlParts = [];
  let h2Count = 0;
  let pCount = 0;
  let hasTable = false;
  let paragraphNumber = 0; // licznik do cytowania w raporcie braków (1-indeksowany, tylko realne akapity)

  for (let i = 0; i < bodyItems.length; i++) {
    const item = bodyItems[i];

    if (item.type === 'table') {
      hasTable = true;
      const [header, ...rows] = item.rows;
      const thead = `<thead><tr>${header.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      htmlParts.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    const trimmed = item.text.trim();
    if (trimmed === '') continue;
    paragraphNumber++;

    // Znaczniki CTA: w środku treści — tylko Artykuł 1 (8x "Zobacz kolekcję – TUTAJ URL KOLEKCJI").
    // Wstawiane jako zwykły akapit bez linku, logowane jako brak (puste miejsce na link).
    if (trimmed.startsWith('CTA:')) {
      const ctaText = trimmed.replace(/^CTA:\s*/, '');
      htmlParts.push(`<p>${escapeHtml(ctaText)}</p>`);
      pCount++;
      gaps.push({ paragraph: paragraphNumber, type: 'cta-bez-linku', quote: ctaText });
      continue;
    }

    // Nieudokumentowane pole "Link:" (tylko Artykuł 8, po zdaniu zamykającym) — poza
    // mapowaniem z promptu, pomijane z treści, logowane osobno.
    if (/^Link\s*:/u.test(trimmed)) {
      gaps.push({ paragraph: paragraphNumber, type: 'nieudokumentowane-pole-link', quote: trimmed });
      continue;
    }

    // Ręczny wyjątek: podpis/etykieta mapki, której nigdy nie było w dokumencie.
    if (MANUAL_EXCLUDE.has(trimmed)) {
      gaps.push({ paragraph: paragraphNumber, type: 'etykieta-brakujacej-grafiki', quote: trimmed });
      continue;
    }

    const glued = isGlued(item.runs);
    const isHeading = !glued && i !== lastNonBlankIdx && trimmed.length <= MAX_HEADING_LEN && !/[.,;:]$/.test(trimmed);

    if (isHeading) {
      htmlParts.push(`<h2>${escapeHtml(trimmed)}</h2>`);
      h2Count++;
    } else {
      const inner = item.runs.map((r) => (r.bold ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text))).join('');
      htmlParts.push(`<p>${inner}</p>`);
      pCount++;
    }

    // [DO UZUPEŁNIENIA...] — zostaje w treści verbatim (już jest, nic nie robimy), ale
    // każde wystąpienie loguje się do braków, z cytatem.
    const placeholderMatches = [...trimmed.matchAll(/\[([^\]]*)\]/g)];
    for (const m of placeholderMatches) {
      gaps.push({ paragraph: paragraphNumber, type: 'do-uzupelnienia', quote: `[${m[1]}]`, context: trimmed });
    }
  }

  // Luka strukturalna specyficzna dla Artykułu 8: brak nagłówka przed listą sezonową
  // (zaakceptowane w Kroku 0 jako luka w źródle, nie błąd rozpoznania).
  if (art.num === 8) {
    gaps.push({
      paragraph: null,
      type: 'brakujacy-naglowek',
      quote: '(brak)',
      context: 'Lista sezonowa (Luty–marzec … Listopad–grudzień–styczeń) nie ma wprowadzającego nagłówka, w odróżnieniu od każdej innej sklejonej listy w pozostałych 7 artykułach.',
    });
  }

  return {
    num: art.num,
    handle,
    title,
    seoTitle,
    metaDescription,
    summary,
    tags,
    linkiWewnetrzne,
    bodyHtml: htmlParts.join(''),
    h2Count,
    pCount,
    hasTable,
    gaps,
  };
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

const ARTICLE_CREATE_MUTATION = /* GraphQL */ `
  mutation MmwArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        handle
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function buildGapsMarkdown(articles) {
  const lines = [];
  lines.push('# Braki i uwagi do artykułów na bloga');
  lines.push('');
  lines.push(
    'Wygenerowane automatycznie przy imporcie z `artykuly-blog.docx`. Treść artykułów przeniesiona wiernie, ' +
      'bez poprawek i bez uzupełniania poniższych braków — to lista rzeczy do przejrzenia przed publikacją.'
  );
  lines.push('');

  for (const art of articles) {
    lines.push(`## Artykuł ${art.num}: ${art.title}`);
    lines.push('');
    lines.push(`Handle: \`${art.handle}\``);
    lines.push('');
    if (art.gaps.length === 0) {
      lines.push('Brak zgłoszonych braków.');
      lines.push('');
      continue;
    }
    const grouped = {};
    for (const gap of art.gaps) {
      if (!grouped[gap.type]) grouped[gap.type] = [];
      grouped[gap.type].push(gap);
    }
    const TYPE_LABELS = {
      'do-uzupelnienia': '`[DO UZUPEŁNIENIA]` w treści',
      'cta-bez-linku': 'Wstawka CTA bez linku (redaktor nie wpisał URL-a)',
      'etykieta-brakujacej-grafiki': 'Etykieta grafiki, której nigdy nie było w dokumencie',
      'nieudokumentowane-pole-link': 'Nieudokumentowane pole poza mapowaniem z briefu',
      'brakujacy-naglowek': 'Brakujący nagłówek sekcji (luka w źródle, nie błąd rozpoznania)',
      'cta-metadana-z-placeholderem': 'Metadana CTA (nad "Treść:") zawiera placeholder — nie wstawiona do treści, ale wymaga URL-a',
    };
    for (const [type, items] of Object.entries(grouped)) {
      lines.push(`**${TYPE_LABELS[type] ?? type}** (${items.length}):`);
      for (const g of items) {
        const loc = g.paragraph ? `akapit ${g.paragraph}` : 'brak konkretnego akapitu';
        lines.push(`- ${loc} — „${g.quote}"${g.context && g.context !== g.quote ? ` (kontekst: „${g.context}")` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## Linki wewnętrzne — sprawdzone przez Admin API');
  lines.push('');
  lines.push(
    'Pole „Linki wewnętrzne" to notatki redakcyjne (nie wstawione do treści artykułów). Poniżej stan ' +
      'weryfikacji względem katalogu sklepu, artykuł po artykule:'
  );
  lines.push('');
  for (const art of articles) {
    lines.push(`**Artykuł ${art.num}**: ${art.linkiWewnetrzne || '(brak pola)'}`);
  }
  lines.push('');
  lines.push('Ustalenia:');
  lines.push(
    '- Wszystkie referencje `/collections/...` oraz nazwy produktów (Solaris, Johanniter, cydr Pomarium, ' +
      'Polini, VIVA, Wódka Walicki itd.) istnieją w katalogu — zweryfikowane przez Admin API.'
  );
  lines.push(
    '- **`balsamico jabłkowe` (Artykuł 4) — realne ryzyko cichego 404.** Naturalny slug z tego tekstu to ' +
      '`balsamico-jablkowe`, ale prawdziwy handle produktu w sklepie to `balsamico-jabkowe` (literówka po stronie ' +
      'sklepu, brakujące „ł" — nie nasza pomyłka, ale link zrobiony automatem z tekstu artykułu trafi w 404).'
  );
  lines.push(
    '- **`vouchery` vs `vouchery-1` — niespójność, nie błąd 404.** Obie kolekcje istnieją. Artykuł 7 odwołuje się ' +
      'do obu naraz, Artykuły 1 i 8 tylko do `vouchery-1`. Który handle jest właściwy?'
  );
  lines.push(
    '- „Chardonnay" (Artykuł 3) pojawia się wyłącznie w kontekście „czego NIE sadzimy" — to nie próba linkowania, ' +
      'nie licz tego jako braku.'
  );
  lines.push(
    '- „Riesling Barrique" nie występuje w dokumencie w żadnym artykule — sprawdzone bezpośrednio w tekście źródłowym.'
  );
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(args.dryRun ? 'Tryb: DRY-RUN (bez zapisu do Shopify)' : 'Tryb: COMMIT (realny zapis, published: false)');
  console.log('');

  const rawArticles = parseDocx();
  console.log(`Wczytano ${rawArticles.length} artykułów z .docx.`);
  console.log('');

  const articles = rawArticles.map(buildArticle);

  console.log('--- Plan (dry-run) ---');
  for (const art of articles) {
    console.log(`\nArtykuł ${art.num}`);
    console.log(`  handle: ${art.handle}`);
    console.log(`  title: ${art.title}`);
    console.log(`  długość HTML: ${art.bodyHtml.length} znaków`);
    console.log(`  <h2>: ${art.h2Count}, <p>: ${art.pCount}, tabela: ${art.hasTable ? 'tak' : 'nie'}`);
    console.log(`  tagi: ${art.tags.join(', ')}`);
    console.log(`  SEO title: ${art.seoTitle}`);
    console.log(`  Meta description: ${art.metaDescription}`);
    console.log(`  braki znalezione: ${art.gaps.length}`);
  }

  const gapsMarkdown = buildGapsMarkdown(articles);
  writeFileSync(GAPS_FILE, gapsMarkdown, 'utf8');
  const totalGaps = articles.reduce((s, a) => s + a.gaps.length, 0);
  console.log(`\n\nZapisano ${GAPS_FILE} (${totalGaps} pozycji łącznie).`);

  if (args.dryRun) {
    console.log('\nDry-run zakończony. Aby zapisać do Shopify, uruchom z flagą --commit.');
    return;
  }

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error('Brak SHOPIFY_STORE lub SHOPIFY_ADMIN_TOKEN w .env.');
    process.exit(1);
  }

  console.log('\nZapisuję artykuły (published: false)...');
  for (const art of articles) {
    const articleInput = {
      blogId: BLOG_ID,
      title: art.title,
      handle: art.handle,
      body: art.bodyHtml,
      summary: art.summary,
      tags: art.tags,
      author: { name: AUTHOR_NAME },
      isPublished: false,
      metafields: [
        ...(art.seoTitle
          ? [{ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: art.seoTitle }]
          : []),
        ...(art.metaDescription
          ? [{ namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: art.metaDescription }]
          : []),
      ],
    };
    const data = await graphqlWithRetry({ store, token, query: ARTICLE_CREATE_MUTATION, variables: { article: articleInput } });
    const userErrors = data.articleCreate.userErrors;
    if (userErrors.length > 0) {
      console.log(`  BŁĄD (Artykuł ${art.num}, ${art.handle}): ${JSON.stringify(userErrors)}`);
      console.log('  Przerywam — kolejne artykuły NIE są zapisywane.');
      process.exitCode = 1;
      return;
    }
    console.log(`  OK — Artykuł ${art.num}: ${data.articleCreate.article.handle} (${data.articleCreate.article.id})`);
    await sleep(RATE_LIMIT_DELAY_MS);
  }
  console.log('\nGotowe. Zapisano 8 artykułów jako published: false.');
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err.message);
  process.exit(1);
});
