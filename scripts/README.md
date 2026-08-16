# Import metaobiektów — zamiennik Matrixify

Skrypt `import-metaobjects.mjs` czyta eksport metaobiektów w formacie Matrixify (.xlsx)
i importuje je do Shopify przez Admin GraphQL API (`metaobjectUpsert`), zamiast
przez appkę Matrixify.

## Setup

1. W katalogu `scripts/` zainstaluj zależności:

   ```
   cd scripts
   npm install
   ```

2. Utwórz plik `.env` **dokładnie w**: `scripts/.env` (obok `package.json`,
   nie w katalogu głównym repo). Wzór w `scripts/.env.example`:

   ```
   SHOPIFY_STORE=majatekmalawies.myshopify.com
   SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   Token: Admin API access token custom app z uprawnieniem
   `write_metaobjects` (i `read_metaobjects`), wygenerowany w
   Shopify Admin → Settings → Apps and sales channels → Develop apps.

   `.env` jest w `.gitignore` — nigdy nie commitować tego pliku.

3. Skrypt używa Admin API w wersji `2026-07` (aktualna stabilna w momencie
   pisania skryptu). Jeśli Shopify wyda nowszą wersję, zaktualizuj stałą
   `API_VERSION` na górze `import-metaobjects.mjs`.

## Format pliku wejściowego

Arkusz Matrixify z metaobiektami, kolumny: `ID`, `Handle`, `Command`,
`Definition: Handle`, `Definition: Name`, `Top Row`, `Row #`, `Field`, `Value`.
Jeden wpis metaobiektu jest rozbity na wiele wierszy (po jednym na pole),
sklejanych po kolumnie `Handle`. Skrypt grupuje wiersze i buduje z nich
`{ handle, type, fields: [{key, value}] }`.

Wpisy z `Command = DELETE` są pomijane (skrypt tylko tworzy/aktualizuje —
upsert po `handle: { type, handle }`).

## Dry-run (domyślnie)

Bez flagi `--commit` skrypt **niczego nie wysyła do Shopify** — tylko
parsuje plik i wypisuje, co by zrobił:

```
npm run import -- --file ./eksport.xlsx
```

lub bezpośrednio:

```
node import-metaobjects.mjs --file ./eksport.xlsx
```

Sprawdź w wypisanej liście, czy handle/typ/pola się zgadzają, zanim zrobisz
realny import.

## Commit (realny import)

```
npm run import:commit -- --file ./eksport.xlsx
```

lub:

```
node import-metaobjects.mjs --file ./eksport.xlsx --commit
```

Skrypt:
- loguje postęp `[n/total]` dla każdego wpisu,
- czeka między mutacjami (rate limiting) i automatycznie ponawia próbę
  z backoffem przy `THROTTLED`,
- sprawdza `userErrors` po każdej mutacji,
- na końcu wypisuje raport: ile OK, ile błędów, które handle się nie
  zaimportowały.

## Znana podatność w `xlsx` (do świadomości)

Pakiet `xlsx` (SheetJS) w wersji z rejestru npm (0.18.5 — ostatnia tam
opublikowana) ma dwie znane, niepatchowane na npm podatności: prototype
pollution i ReDoS przy parsowaniu plików ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6),
[GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)).
SheetJS przeniósł łatane wydania (aktualnie 0.20.3) wyłącznie na własny CDN
(`cdn.sheetjs.com`) — instalacja stamtąd jest jednak zablokowana w tym
środowisku przez politykę npm (`allow-remote-packages`), więc zostaje
wersja z rejestru.

W praktyce ryzyko jest ograniczone: skrypt parsuje wyłącznie plik, który
sam eksportujesz z Matrixify — nie plik od nieznanej/zewnętrznej strony.
Jeśli chcesz mieć łataną wersję, pobierz ręcznie
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, umieść lokalnie
i zainstaluj przez `npm install ./xlsx-0.20.3.tgz`, albo odblokuj zdalne
paczki w konfiguracji npm — nie rób tego jednak bez świadomości, że to
zmiana polityki bezpieczeństwa npm w tym środowisku.

## Ograniczenia

- Wartości pól (w tym `file` i `color`) są zawsze wysyłane jako string —
  bez dodatkowej walidacji typu pola po stronie skryptu. Odpowiedzialność
  za poprawny format wartości (np. GID pliku dla pola typu `file`) leży
  po stronie danych wejściowych.
- Import nie obsługuje usuwania metaobiektów (`Command = DELETE` jest
  pomijane, nie mapowane na `metaobjectDelete`).

## export-produkty-xlsx.mjs

Eksportuje dwa arkusze (`scripts/eksport/produkty-wina.xlsx`,
`produkty-spozywcze.xlsx`, oba gitignored — dane produkcyjne, nie kod) do
uzupełnienia przez content team, przez Admin GraphQL API (nie Matrixify —
limity). Read-only względem Shopify.

```
node export-produkty-xlsx.mjs
```

Klasyfikacja wina/spożywcze, zestaw kolumn (w tym rozbicie skal
sensorycznych na osobne kolumny per oś, 1–3) i mechanizm wierszy-wzorców
("WZÓR", zablokowane, zawsze pomijane przy imporcie) — patrz zakładka
"Instrukcja" w każdym pliku wynikowym oraz historia rozmowy, w której
ustalano te reguły. Reużywa `lib/shopify-graphql.mjs` i
`lib/fetch-metaobjects.mjs` z importu sensoryki.

Wymaga pakietu `exceljs` (nie samego `xlsx` — community `xlsx` nie ma
wystarczającego wsparcia dla data validation/ochrony arkusza/wypełnień
komórek). `npm audit` pokazuje jedną umiarkowaną podatność w `uuid`
(zależność `exceljs`) — narzędzie lokalne, nie trafia do motywu, świadomie
nieaktualizowane (fix wymaga downgrade `exceljs` do wersji z breaking
change).

Skrypt importu z powrotem do Shopify (nazwa → GID przez
`resolve-metaobject-handle.mjs`) — jeszcze nie napisany, osobne zadanie.
