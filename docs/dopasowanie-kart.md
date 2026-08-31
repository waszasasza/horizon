# Dopasowanie kart technicznych PDF do produktów

Wygenerowane przy przeglądzie `scripts/karty/`. Zakres: `.pdf` poza folderem `B&W`
(pominiętym w całości) i poza podfolderami `PNG` (ignorowanymi całkowicie).

## Diagnoza (Etap 0)

**Ograniczenie kategorii na `custom.karta_produktu`**: pole ma 720 dozwolonych
kategorii ze standardowej taksonomii Shopify. Sprawdzone bezpośrednio (Admin API,
`metafieldDefinition.constraints`, z paginacją — 720 to pełna liczba, nie limit
zapytania): `fb-1-1` (Food, Beverages & Tobacco > Beverages > Alcoholic Beverages)
i `fb-1-1-7` (ta sama gałąź > Wine) — obie kategorie realnie przypisane do
produktów docelowych — są w dozwolonym zbiorze. **Werdykt: zero konfliktów.**
Wszystkie 29 sprawdzonych produktów wina/cydru/piwa/wódki ma jedną z tych dwóch
kategorii, obie dozwolone.

**Typ pola**: `file_reference` (pojedyncza wartość, NIE `list.file_reference`) —
każdy produkt może mieć dokładnie jedną kartę.

**Już wypełnione**: jeden produkt — `ksiaze-regent-2024` ("Książe Regent 2024").
Obecna wartość to `gid://shopify/MediaImage/62818700067149`, plik `Mac-5.webp`,
bez alt textu — wyglądał na przypadkowy placeholder, nie prawdziwą kartę
techniczną. **Zaakceptowane do nadpisania** — podepnę `2024/HISTORYCZNE/PDF/
Książę Regent 2024.pdf` w Etapie 2. W raporcie z Etapu 2 zapiszę jawnie, że
stara wartość (`Mac-5.webp`, GID wyżej) została zastąpiona, na wypadek gdyby
ktoś tego pliku szukał.

**Liczba PDF-ów**: 28 w zakresie (po wykluczeniu B&W i PNG), z czego:
- **19 dopasowanych pewnie**
- **1 rozbieżność rocznik-folder** (Vicu Faun)
- **8 bez dopasowania** (produkt istnieje, ale nie w tym roczniku, lub w ogóle nie istnieje)
- odrzuconych: **4 PDF w `B&W`** (cały folder pominięty) + **23 PNG** (ignorowane całkowicie)

## Dwie rozbieżności z brief'u — WAŻNE, sprawdzone bezpośrednio w katalogu

1. **Blanc i Riesling Barrique JUŻ ISTNIEJĄ jako produkty** (`blanc-2025`,
   `riesling-barrique-2025`, oba ACTIVE, kategoria Wine, `karta_produktu` puste).
   Brief zakładał, że żadnego z nich nie ma w sklepie i kazał czekać z ich kartami
   na „utworzenie produktu po utworzeniu" — to już nieaktualne. Dopasowałam je
   normalnie do tabeli poniżej, do standardowej ścieżki wgrania w Etapie 2, NIE do
   sekcji „do wgrania po utworzeniu produktu".
2. **Chardonnay nadal nie istnieje** (potwierdzone, zero trafień) — zgodnie
   z brief'em, w sekcji „do wgrania po utworzeniu produktu" niżej.
3. **Dodatkowo, poza brief'em: Hibernal też nie istnieje jako produkt w ogóle**
   (nie tylko brak rocznika 2024 — zero produktów o tej nazwie w katalogu).
   Ten sam przypadek co Chardonnay, dodany do tej samej sekcji.

## Riesling Barrique … (2).pdf — werdykt

**Nie ma z czym porównać.** Sprawdziłam bezpośrednio wszystkie pięć plików
w drzewie z sufiksem `(N)` (`Regent 2024 (1).pdf`, `Riesling Barrique 2025
wytrawny (2).pdf`, `Rose 2025 (3).pdf`, `Solaris wytrawny 2025 (1).pdf`,
`muscaris 2025 (2).pdf`) — dla ŻADNEGO z nich nie istnieje wersja bez sufiksu
w tym samym folderze. Każdy jest jedynym plikiem o tej nazwie. Dodatkowo
wszystkie pięć ma identyczny znacznik czasu modyfikacji (28 sie, 13:56) —
najpewniej ślad jednorazowej ekstrakcji archiwum, nie dwóch osobnych pobrań —
więc nawet gdyby istniała para do porównania, data pliku i tak nic by nie
mówiła o tym, która wersja jest „aktualna". **Sufiks `(N)` to najpewniej ślad
nazewnictwa z folderu źródłowego klienta, nie sygnał duplikatu do rozstrzygnięcia
— każdy z tych pięciu plików jest używalny wprost, bez zmian treści.**

**Nazewnictwo przy wgrywaniu (Etap 2)**: sufiks `(N)` zostaje w ścieżce źródłowej,
ale **NIE** w nazwie pliku w bibliotece Shopify — widoczny dla klienta przy
pobieraniu wyglądałby niechlujnie. `fileCreate` dostanie czystą nazwę bez
sufiksu (np. `Riesling Barrique 2025 wytrawny (2).pdf` → plik w bibliotece jako
„Riesling Barrique 2025 wytrawny.pdf"). Dotyczy wszystkich pięciu: Regent 2024,
Riesling Barrique 2025, Rose 2025, Solaris wytrawny 2025, muscaris 2025.

## Dopasowania pewne — do akceptacji

| Ścieżka pliku | Handle produktu | Pewność | Uzasadnienie |
|---|---|---|---|
| `2024/FENIX/PDF/Fenix Alfresco 2024.pdf` | `fenix-blanc-alfresco` | pewne | Produkt nie jest rocznikowany (brak roku w handle) — jedyny kandydat |
| `2024/FENIX/PDF/Fenix Barrique 2024.pdf` | `fenix-blanc-barrique` | pewne | jw. |
| `2024/HISTORYCZNE/PDF/Książę Regent 2024.pdf` | `ksiaze-regent-2024` | pewne | Nazwa + rok zgodne. **Zaakceptowane nadpisanie** placeholdera `Mac-5.webp`, patrz wyżej |
| `2024/HISTORYCZNE/PDF/Wojewoda 2024.pdf` | `wojewoda-2024` | pewne | Nazwa + rok zgodne, pole puste |
| `2024/POLINI/Polini Aperitivo.pdf` | `polini-aperitivo` | pewne | Produkt nie jest rocznikowany — jedyny kandydat |
| `2024/VICU/Flora 2024.pdf` | `vicu-flora-2024` | pewne | Rok zgodny |
| `2024/VICU/Medusa 2024.pdf` | `vicu-medusa-2024` | pewne | Rok zgodny |
| `2024/WPMW/Orange 2024.pdf` | `orange-2024` | pewne | Rok zgodny |
| `2024/WPMW/Regent 2024 (1).pdf` | `regent-2024` | pewne | Rok zgodny; sufiks „(1)" bez wersji do porównania, plik używalny wprost |
| `2024/WPMW/Rouge 2024.pdf` | `rouge-2024` | pewne | Rok zgodny |
| `2024/WPMW/Souvignier 2024.pdf` | `souvignier-gris-2024` | pewne | Nazwa pliku pomija „Gris", ale to jedyny produkt Souvignier w katalogu |
| `2024/WPMW/solaris półwytrawny 2024.pdf` | `solaris-powytrawny-2024` | pewne | Rok + wariant (półwytrawny) zgodne |
| `2025/WPMW/Blanc 2025.pdf` | `blanc-2025` | pewne | Rok zgodny — produkt istnieje (patrz uwaga wyżej) |
| `2025/WPMW/Johanniter 2025.pdf` | `johanniter-2025` | pewne | Rok zgodny |
| `2025/WPMW/Riesling 2025.pdf` | `riesling-2025` | pewne | Rok zgodny |
| `2025/WPMW/Riesling Barrique 2025 wytrawny (2).pdf` | `riesling-barrique-2025` | pewne | Rok zgodny — produkt istnieje (patrz uwaga wyżej); sufiks „(2)" bez wersji do porównania |
| `2025/WPMW/Rose 2025 (3).pdf` | `rose-2025` | pewne | Rok zgodny; sufiks „(3)" bez wersji do porównania |
| `2025/WPMW/Solaris wytrawny 2025 (1).pdf` | `solaris-wytrawny-2025` | pewne | Rok + wariant (wytrawny) zgodne; sufiks „(1)" bez wersji do porównania |
| `2025/WPMW/muscaris 2025 (2).pdf` | `muscaris-2025` | pewne | Rok zgodny; sufiks „(2)" bez wersji do porównania |

## Rozbieżność rocznik-folder — zgłoszona, NIE dopasowana

| Ścieżka pliku | Problem |
|---|---|
| `2024/VICU/Faun 2024.pdf` | Folder i nazwa pliku zgodnie mówią 2024, ale jedyny produkt Vicu Faun w katalogu to `vicu-faun-2025` (2025). Rok się nie zgadza — zgodnie z regułą, nie dopasowuję. W drzewie nie ma żadnego pliku „Faun 2025". **Nie zgaduję, czy to to samo wino** — pytanie do klienta, patrz sekcja niżej |

## Do wgrania po utworzeniu produktu (produkt nie istnieje w ogóle)

| Ścieżka pliku | Brakujący produkt |
|---|---|
| `2025/WPMW/Chardonnay 2025 wytrawny.pdf` | Chardonnay — zero trafień w katalogu |
| `2024/WPMW/hibernal 2024.pdf` | Hibernal — zero trafień w katalogu (dodatkowe znalezisko, spoza brief'u) |

## PDF-y bez dopasowania (produkt istnieje, ale nie w tym roczniku)

| Ścieżka pliku | Powód |
|---|---|
| `2024/WPMW/Johanniter 2024.pdf` | Katalog ma tylko `johanniter-2025` |
| `2024/WPMW/Riesling 2024.pdf` | Katalog ma tylko `riesling-2025` |
| `2024/WPMW/Rose 2024.pdf` | Katalog ma tylko `rose-2025` |
| `2024/WPMW/Solaris 2024 wytrawny.pdf` | Katalog nie ma „solaris wytrawny 2024" — jest tylko `solaris-wytrawny-2025` (wytrawny, inny rok) i `solaris-powytrawny-2024` (**inny wariant** — półwytrawny, nie wytrawny; to nie ten sam produkt mimo wspólnego roku) |
| `2024/WPMW/blanc 2024.pdf` | Katalog ma tylko `blanc-2025` |
| `2024/WPMW/muscaris 2024.pdf` | Katalog ma tylko `muscaris-2025` |

## Produkty bez karty (10)

Żaden plik PDF w drzewie ich nie dotyczy — dla cydru/piwa/wódki/konfitury folder
`karty/` w ogóle nie ma odpowiednich podfolderów, to nie luka w dopasowaniu:

- `vicu-faun-2025` (jedyny plik „Faun" jest z 2024, patrz rozbieżność wyżej)
- `cydr-pomarium-750ml-powytrawny`
- `cydr-pomarium-750ml-wytrawny`
- `cydr-pomarium-330ml-powytrawny`
- `cydr-pomarium-330ml-wytrawny`
- `polini-spritz`
- `konfitura-z-wina`
- `wodka-walicki`
- `piwo-viva-pale-ale`
- `piwo-viva-weissbier`

## Do przekazania Markowi — pytania otwarte, nie zgadujemy

Trzy osobne rzeczy, zebrane w jednym miejscu do przekazania klientowi:

1. **Vicu Faun — to samo wino czy nieaktualna karta?** `2024/VICU/Faun 2024.pdf`
   nie pasuje rocznikiem do jedynego produktu w katalogu (`vicu-faun-2025`).
   Pytanie do Marka: czy Vicu Faun 2025 na sklepie to to samo wino co karta
   z 2024 (wtedy karta jest po prostu źle podpisana rocznikiem i można ją użyć),
   czy to inny rocznik i karta z 2024 jest nieaktualna (wtedy czekamy na nową).
2. **Chardonnay i Hibernal — nowe wina do założenia.** Oba nie istnieją jako
   produkty. Karty PDF już czekają (`Chardonnay 2025 wytrawny.pdf`,
   `hibernal 2024.pdf`) — gdy produkty powstaną, podpięcie jest gotowe do
   zrobienia od razu. Hibernal to nazwisko, którego nie było wcześniej na
   liście win do założenia — warto, żeby Marek o nim wiedział przy okazji
   Chardonnay, nie osobno.
3. **Cydr, piwo, wódka, konfitury — karty w ogóle nie istnieją, czy ten folder
   ich po prostu nie dotyczy?** 10 produktów bez dopasowania (lista wyżej) nie
   ma odpowiadających podfolderów w `karty/` w ogóle — żaden plik PDF dla nich
   nie istnieje w dostarczonym archiwum. Nie zgaduję, czy to znaczy „karty nie
   istnieją" czy „te produkty nie dostają kart technicznych z zasady" —
   pytanie do Marka.
