# Audyt handle'i — wycięte polskie znaki i sklejone wyrazy

## ✅ Status naprawy (2026-09-01)

**28 produktów naprawionych.** Wzorzec A (brakujące „ł") poprawiony w handle'ach
26 produktów wykrytych automatycznie + 2 produktów dopisanych ręcznie
(„Skarpetki - freski pałacowe", „Skarpetki - pałac" — miały ręcznie doklejony
kod rozmiaru `-r-40-42`, którego nie ma w tytule, więc metoda automatyczna je
odrzucała; poprawiono wyłącznie „ł", rozmiar zachowany bez zmian). Wykonane
skryptem `scripts/napraw-handle-l-produkty.mjs` (dry-run domyślnie, `--commit`
do zapisu, commit `49f5564`). Zero błędów, zero kolizji handle'i, potwierdzone
ponownym dry-runem po zapisie (zero pozostałych kandydatów).

**Nie utworzono żadnych przekierowań** — świadomie, `redirectNewHandle: false`
w każdej mutacji `productUpdate` (zweryfikowane introspekcją GraphQL na naszej
wersji API 2026-07, że to pole jest opt-in, nie automatyczne przy zmianie przez
API — w odróżnieniu od edycji w Adminie, gdzie jest domyślnie zaznaczony
checkbox). Powód: **sklep jest za hasłem** (`majatekmalawies.myshopify.com`
przekierowuje na `/password`, brak własnej domeny) — stare handle'e nigdy nie
były i nie mogły być zaindeksowane przez Google ani żadną wyszukiwarkę.
Przekierowanie z adresu, którego nikt nie zna i nikt nie zaindeksował, nie ma
żadnej korzyści SEO — byłoby wyłącznie zbędnym wpisem do posprzątania później.

**Kubełek „inne" — rozstrzygnięty**, decyzje niżej w sekcji „Sekcja «inne»".

Reszta tego dokumentu to oryginalny audyt sprzed naprawy (dane z 2026-09-01,
przed zmianą) — handle'e w kolumnie „Handle obecny" w tabeli produktów
odpowiadają stanowi SPRZED naprawy dla 28 poprawionych pozycji; kolumna
„Decyzja/Status" mówi, co się z nimi stało.

---

Audyt, nie naprawa *(w momencie pisania — patrz status wyżej)*. Dane pobrane
READ-ONLY z Admin GraphQL API (`shopify.dev`, wersja `2026-07`) — wszystkie
typy zasobów: produkty, kolekcje, strony, artykuły bloga, blogi.

**Poprawna transliteracja** (wzorzec do porównania): `ą→a, ć→c, ę→e, ł→l, ń→n,
ó→o, ś→s, ź→z, ż→z` (wielkie litery analogicznie), spacje — w tym twarde
(U+00A0) — na myślniki, znaki interpunkcyjne usuwane.

**Metoda klasyfikacji A/B**: zamiast prostego "różni się od proponowanego =
błąd", każdy rozjazd testowany jest przeciw trzem rekonstrukcjom hipotez z
promptu: (1) sama utrata „ł" bez ruszania spacji, (2) samo sklejenie słów przy
twardej spacji bez ruszania „ł", (3) oba naraz. Handle klasyfikowany jako A/B/A+B
tylko gdy pasuje **dokładnie** do jednej z tych rekonstrukcji — inaczej ląduje w
„inne", zgodnie z poleceniem, żeby nie wrzucać niepewnych przypadków do jednego
worka z potwierdzonymi błędami.

---

## ⚠️ Ważne znalezisko, zanim przejdziesz do tabel

Sprawdziłem 5 przykładowych URL-i z Twojego zgłoszenia bezpośrednio w bieżących
danych Admin API. **3 z 5 nie zgadzają się z dzisiejszym stanem sklepu**:

| URL ze zgłoszenia | Stan dzisiaj (Admin API) |
|---|---|
| `/products/olej-zioowy-toczniaksiazeca-zioa-prowansalskie` | Produkt "Olej Ziołowy Tłocznia Książęca - Zioła Prowansalskie" ma dziś handle `olej-zioowy-**tocznia-ksiazeca**-zioa-prowansalskie` — **z myślnikiem między "tocznia" i "ksiazeca"**, nie sklejone. Zgadza się tylko wzorzec A (brak „l"), wzorca B już nie ma. |
| `/products/skarpetki-paa-cr-40-42` | **Nie znaleziono żadnego produktu z takim handle'em.** Najbliższe istniejące: `skarpetki-freski-paacowe-r-40-42` i `skarpetki-paac-r-40-42` — oba bez „cr", z „r" zamiast „cr". Możliwe, że to inny/usunięty produkt, albo handle był ręcznie poprawiony po zgłoszeniu. |
| `/products/ksiazka-maa-wies-ijej-dzieje` | Produkt "Książka Mała Wieś i jej dzieje" ma dziś handle `ksiazka-maa-wies-**i-jej**-dzieje` — **„i" i „jej" oddzielone myślnikiem**, nie sklejone. Tylko wzorzec A. |
| `/products/filet-z-ososia-z-sosem-porowym-z-solarisem` | Zgadza się dokładnie — wzorzec A. |
| `/products/balsamico-jabkowe` | Zgadza się dokładnie — wzorzec A. |

Dwa przykłady czysto-A (bez podejrzenia B) zgadzają się co do litery. **Wszystkie
trzy przykłady, które miały ilustrować sklejanie wyrazów (wzorzec B), dziś w
Admin API tego sklejenia nie mają** — dwa z nich mają już poprawne myślniki
między słowami, trzeci nie istnieje w ogóle pod tym handle'em.

Do tego: **żaden tytuł w całym sklepie (149 zasobów) nie zawiera dziś znaku
U+00A0** — sprawdzone bezpośrednio na surowych bajtach UTF-8 z odpowiedzi API,
nie przez wyświetlanie tekstu. Więcej w sekcji „Hipoteza U+00A0" niżej.

**Co to może znaczyć** (nie mam dostępu do `urlRedirects` — token nie ma tego
zakresu — więc nie potwierdziłem tego przez przekierowania):
- SEO korzystało ze starszych/cache'owanych danych (stary sitemap, indeks
  Google, eksport sprzed jakiejś zmiany) — realne handle'e w sklepie mogły się
  już zmienić od czasu zbierania tych przykładów.
- Ktoś mógł już ręcznie poprawić te konkretne 2-3 handle'e (przy edycji handle'a
  w adminie Shopify tworzy automatyczne przekierowanie 301 ze starego adresu —
  jeśli tak było, stary URL nadal działa, tylko przez redirect, nie jako
  bezpośredni handle).
- Nie da się wykluczyć literówki w samym zgłoszeniu.

**Wniosek dla obrazu problemu**: wzorzec A („ł" znika) jest w pełni potwierdzony
i pasuje 1:1 do przykładów. Wzorzec B (sklejanie przez twardą spację) —
**w obecnych danych sklepu nie znalazłem ANI JEDNEGO potwierdzonego
przypadku**, mimo że przeszukałem wszystkie 149 zasobów. Traktowałbym problem B
jako **historyczny/już nieaktualny**, chyba że masz dostęp do tego, skąd
pochodzą oryginalne przykłady (crawler, eksport), i możesz zweryfikować datę
zbierania danych.

---

## Tabele — zasoby dotknięte (wzorzec A/B/A+B/inne)

Poniżej WYŁĄCZNIE zasoby, których handle różni się od poprawnej transliteracji
tytułu. Zasoby zgodne (`OK`) pominięte w tabelach — pełne liczby w podsumowaniu.

### Produkty (26× A, 4× inne, 93 zgodne, 123 przebadane)

Kolumna „Handle obecny" = stan SPRZED naprawy (moment audytu). Zobacz kolumnę
„Decyzja/Status" za informacją, co się z każdą pozycją stało.

| Tytuł | Handle obecny (przed naprawą) | Handle proponowany | Wzorzec | Decyzja/Status |
|---|---|---|---|---|
| Balsamico jabłkowe | `balsamico-jabkowe` | `balsamico-jablkowe` | A | ✅ Naprawiono 2026-09-01 |
| Chipsy jabłkowe | `chipsy-jabkowe` | `chipsy-jablkowe` | A | ✅ Naprawiono 2026-09-01 |
| Chutney jabłkowy | `chutney-jabkowy` | `chutney-jablkowy` | A | ✅ Naprawiono 2026-09-01 |
| Clementine olejek do ciała | `clementine-olejek-do-ciaa` | `clementine-olejek-do-ciala` | A | ✅ Naprawiono 2026-09-01 |
| Cydr Pomarium 330ml Półwytrawny | `cydr-pomarium-330ml-powytrawny` | `cydr-pomarium-330ml-polwytrawny` | A | ✅ Naprawiono 2026-09-01 |
| Cydr Pomarium 750ml Półwytrawny | `cydr-pomarium-750ml-powytrawny` | `cydr-pomarium-750ml-polwytrawny` | A | ✅ Naprawiono 2026-09-01 |
| Filet z łososia z sosem porowym z Solarisem | `filet-z-ososia-z-sosem-porowym-z-solarisem` | `filet-z-lososia-z-sosem-porowym-z-solarisem` | A | ✅ Naprawiono 2026-09-01 |
| Herbata jabłkowa | `herbata-jabkowa` | `herbata-jablkowa` | A | ✅ Naprawiono 2026-09-01 |
| Konfitura jabłkowo-różana | `konfitura-jabkowo-rozana` | `konfitura-jablkowo-rozana` | A | ✅ Naprawiono 2026-09-01 |
| Książka Mała Wieś i jej dzieje | `ksiazka-maa-wies-i-jej-dzieje` | `ksiazka-mala-wies-i-jej-dzieje` | A | ✅ Naprawiono 2026-09-01 |
| Marmolada jabłkowa | `marmolada-jabkowa` | `marmolada-jablkowa` | A | ✅ Naprawiono 2026-09-01 |
| Olej Ziołowy Tłocznia Książęca - Szczypiorkowy | `olej-zioowy-tocznia-ksiazeca-szczypiorkowy` | `olej-ziolowy-tlocznia-ksiazeca-szczypiorkowy` | A | ✅ Naprawiono 2026-09-01 |
| Olej Ziołowy Tłocznia Książęca - Warzywa Wędzone | `olej-zioowy-tocznia-ksiazeca-warzywa-wedzone` | `olej-ziolowy-tlocznia-ksiazeca-warzywa-wedzone` | A | ✅ Naprawiono 2026-09-01 |
| Olej Ziołowy Tłocznia Książęca - Zioła Prowansalskie | `olej-zioowy-tocznia-ksiazeca-zioa-prowansalskie` | `olej-ziolowy-tlocznia-ksiazeca-ziola-prowansalskie` | A | ✅ Naprawiono 2026-09-01 |
| Olej z pestek winogron Tłocznia Książęca | `olej-z-pestek-winogron-tocznia-ksiazeca` | `olej-z-pestek-winogron-tlocznia-ksiazeca` | A | ✅ Naprawiono 2026-09-01 |
| Opakowanie kartonowe na 1 wino - białe | `opakowanie-kartonowe-na-1-wino-biae` | `opakowanie-kartonowe-na-1-wino-biale` | A | ✅ Naprawiono 2026-09-01 |
| Sok Jabłkowy Sad Książęcy 3 l | `sok-jabkowy-sad-ksiazecy-3-l` | `sok-jablkowy-sad-ksiazecy-3-l` | A | ✅ Naprawiono 2026-09-01 |
| Sok Jabłkowy Sad Książęcy 330 ml | `sok-jabkowy-sad-ksiazecy-330-ml` | `sok-jablkowy-sad-ksiazecy-330-ml` | A | ✅ Naprawiono 2026-09-01 |
| Sok Jabłkowy Sad Książęcy 5 l | `sok-jabkowy-sad-ksiazecy-5-l` | `sok-jablkowy-sad-ksiazecy-5-l` | A | ✅ Naprawiono 2026-09-01 |
| Sok Jabłkowy Sad Książęcy 750 ml - Antonówka | `sok-jabkowy-sad-ksiazecy-750-ml-antonowka` | `sok-jablkowy-sad-ksiazecy-750-ml-antonowka` | A | ✅ Naprawiono 2026-09-01 |
| Sok Jabłkowy Sad Książęcy 750 ml - Boskoop | `sok-jabkowy-sad-ksiazecy-750-ml-boskoop` | `sok-jablkowy-sad-ksiazecy-750-ml-boskoop` | A | ✅ Naprawiono 2026-09-01 |
| Sok Jabłkowy Sad Książęcy 750 ml - Mix | `sok-jabkowy-sad-ksiazecy-750-ml-mix` | `sok-jablkowy-sad-ksiazecy-750-ml-mix` | A | ✅ Naprawiono 2026-09-01 |
| Solaris półwytrawny 2024 | `solaris-powytrawny-2024` | `solaris-polwytrawny-2024` | A | ✅ Naprawiono 2026-09-01 |
| Torba bawełniana na wino | `torba-baweniana-na-wino` | `torba-bawelniana-na-wino` | A | ✅ Naprawiono 2026-09-01 |
| Świeca sojowa Zmysłowa Róża | `swieca-sojowa-zmysowa-roza` | `swieca-sojowa-zmyslowa-roza` | A | ✅ Naprawiono 2026-09-01 |
| Świeca sojowa Złota Godzina w Ogrodzie | `swieca-sojowa-zota-godzina-w-ogrodzie` | `swieca-sojowa-zlota-godzina-w-ogrodzie` | A | ✅ Naprawiono 2026-09-01 |
| Skarpetki - freski pałacowe | `skarpetki-freski-paacowe-r-40-42` | ~~`skarpetki-freski-palacowe`~~ → **`skarpetki-freski-palacowe-r-40-42`** (ręcznie, rozmiar zachowany) | inne | ✅ Naprawiono 2026-09-01 (tylko „ł", `-r-40-42` bez zmian) |
| Skarpetki - pałac | `skarpetki-paac-r-40-42` | ~~`skarpetki-palac`~~ → **`skarpetki-palac-r-40-42`** (ręcznie, rozmiar zachowany) | inne | ✅ Naprawiono 2026-09-01 (tylko „ł", `-r-40-42` bez zmian) |
| Degustacje wina | `zwiedzanie-winnicy-copy` | `degustacje-wina` | inne | Do skasowania przed importem wydarzeń — handle bez zmian |
| Kurs winiarski – od winorośli do kieliszka | `degustacje-wina-copy` | `kurs-winiarski-od-winorosli-do-kieliszka` | inne | Do skasowania przed importem wydarzeń — handle bez zmian |

### Kolekcje (3× inne, 7 zgodnych, 10 przebadanych)

| Tytuł | Handle obecny | Handle proponowany | Wzorzec | Decyzja |
|---|---|---|---|---|
| Bestsellery | `frontpage` | `bestsellery` | inne | Zostaje — domyślny handle Shopify |
| Wydarzenia | `vouchery` | `wydarzenia` | inne | Czeka na decyzję klienta o strukturze oferty |
| Vouchery | `vouchery-1` | `vouchery` | inne | Czeka na decyzję klienta o strukturze oferty |

### Strony (1× inne, 3 zgodne, 4 przebadane)

| Tytuł | Handle obecny | Handle proponowany | Wzorzec | Decyzja |
|---|---|---|---|---|
| Kontakt | `contact` | `kontakt` | inne | Zostaje — domyślny handle Shopify |

### Blogi (1× inne, 1 przebadany)

| Tytuł | Handle obecny | Handle proponowany | Wzorzec | Decyzja |
|---|---|---|---|---|
| Blog | `news` | `blog` | inne | Zostaje — domyślny handle Shopify |

### Artykuły bloga (8× inne, 3 zgodne, 11 przebadanych — blog „Blog")

| Tytuł | Handle obecny | Handle proponowany | Wzorzec | Decyzja |
|---|---|---|---|---|
| Sklep Majątku Mała Wieś już otwarty. Wszystko, co powstaje wokół pałacu, w jednym miejscu | `sklep-majatek-mala-wies-otwarcie` | `sklep-majatku-mala-wies-juz-otwarty-wszystko-co-powstaje-wokol-palacu-w-jednym-miejscu` | inne | Zostaje — celowy krótki slug SEO |
| Wina z Winnicy Pałac Mała Wieś. Przewodnik po całej kolekcji | `win-winnica-palac-mala-wies-przewodnik` | `wina-z-winnicy-palac-mala-wies-przewodnik-po-calej-kolekcji` | inne | Zostaje — celowy krótki slug SEO |
| Solaris, Johanniter, Muscaris. Co oznaczają te nazwy na etykietach polskich win | `szczepy-win-solaris-johanniter-muscaris` | `solaris-johanniter-muscaris-co-oznaczaja-te-nazwy-na-etykietach-polskich-win` | inne | Zostaje — celowy krótki slug SEO |
| Food Pairing, co do czego? Przewodnik po łączeniu win z Winnicy Pałac Mała Wieś z jedzeniem. | `parowanie-win-winnica-palac-mala-wies-jedzenie` | `food-pairing-co-do-czego-przewodnik-po-laczeniu-win-z-winnicy-palac-mala-wies-z-jedzeniem` | inne | Zostaje — celowy krótki slug SEO |
| Spiżarnia Książęca i Sad Książęcy. Co powstaje z tego, co rośnie wokół pałacu | `spizarnia-ksiazeca-sad-ksiazecy` | `spizarnia-ksiazeca-i-sad-ksiazecy-co-powstaje-z-tego-co-rosnie-wokol-palacu` | inne | Zostaje — celowy krótki slug SEO |
| Cydr Pomarium, Polini i piwo VIVA. Coś więcej niż wino. | `cydr-pomarium-polini-piwo-viva` | `cydr-pomarium-polini-i-piwo-viva-cos-wiecej-niz-wino` | inne | Zostaje — celowy krótki slug SEO |
| Voucher zamiast rzeczy. Degustacja, zwiedzanie winnicy i kurs winiarski w Winnicy Pałac Mała Wieś | `vouchery-degustacja-kurs-winiarski` | `voucher-zamiast-rzeczy-degustacja-zwiedzanie-winnicy-i-kurs-winiarski-w-winnicy-palac-mala-wies` | inne | Zostaje — celowy krótki slug SEO |
| Weekend w Hotelu Pałac Mała Wieś. Jak zaplanować wizytę w winnicy i pałacu godzinę od Warszawy | `weekend-palac-mala-wies-plan-wizyty` | `weekend-w-hotelu-palac-mala-wies-jak-zaplanowac-wizyte-w-winnicy-i-palacu-godzine-od-warszawy` | inne | Zostaje — celowy krótki slug SEO |

---

## Sekcja „inne" — rozstrzygnięta

Żaden z poniższych **17 przypadków** nie pasował 1:1 do rekonstrukcji wzorca A,
B ani A+B — różnią się od tytułu z innego powodu. Wszystkie przejrzane, decyzja
podjęta dla każdej grupy:

**Krótkie SEO-handle'e artykułów (8) — DECYZJA: zostają bez zmian.** Wszystkie
8 artykułów z tabeli wyżej ma handle wyraźnie krótszy i inaczej sformułowany
niż mechaniczna transliteracja długiego, zdaniowego tytułu (np. „Food Pairing,
co do czego? Przewodnik po łączeniu win..." → `parowanie-win-winnica-palac-mala-wies-jedzenie`).
To świadomie napisane, krótsze slugi pod SEO, nie awaria transliteracji.

**Systemowe/domyślne handle'e Shopify (3) — DECYZJA: zostają bez zmian.**
`Kontakt`→`contact`, `Blog`→`news`, `Bestsellery`→`frontpage`. Standardowe
angielskie handle'e, jakie Shopify nadaje domyślnym zasobom (strona
kontaktowa, domyślny blog, kolekcja frontpage) — zostawiane bez zmian nawet
gdy tytuł jest po polsku, zgodnie z konwencją.

**Zamienione handle'e kolekcji (2) — DECYZJA: czeka na decyzję klienta o
strukturze oferty.** Kolekcja „Wydarzenia" ma handle `vouchery`, a kolekcja
„Vouchery" ma handle `vouchery-1`. Wygląda na to, że w pewnym momencie
zmieniono tytuł jednej z nich (albo skopiowano jedną z drugiej) bez
poprawienia handle'a — dziś nazwa i adres nie pasują do siebie. **To nie jest
literowy błąd transliteracji, tylko realny rozjazd treści** — nie naprawiane
w ramach tego zadania (dotyczyło wyłącznie wzorca A), zostawione klientowi do
decyzji, bo dotyka struktury oferty (Wydarzenia vs Vouchery), nie tylko
literówki w adresie.

**Zamienione handle'e produktów (2) — DECYZJA: produkty do skasowania przed
importem wydarzeń, handle bez zmian do tego czasu.** Produkt „Degustacje
wina" ma handle `zwiedzanie-winnicy-copy`, a produkt „Kurs winiarski – od
winorośli do kieliszka" ma handle `degustacje-wina-copy`. Sufiks `-copy`
sugeruje, że któryś z tych produktów powstał przez zduplikowanie innego
(Shopify domyślnie dopisuje `-copy` do handle'a kopii), a potem zmieniono mu
tytuł bez poprawienia handle'a. Oba produkty i tak idą do skasowania przy
imporcie wydarzeń (`scripts/import-wydarzenia.mjs`) — naprawianie handle'a
tymczasowego bytu bez sensu, więc zostawione bez zmian.

**Ręcznie rozszerzone handle'e produktów o kod rozmiaru (2) — DECYZJA:
naprawione częściowo, patrz tabela „Produkty" wyżej.** `Skarpetki - freski
pałacowe` i `Skarpetki - pałac` miały w handle'u ręcznie doklejony fragment
(`-r-40-42` — kod rozmiaru), którego w ogóle nie ma w tytule — stąd „inne", nie
czyste A (nie pasowały 1:1 do żadnej mechanicznej rekonstrukcji). Realny defekt
„ł" w części odpowiadającej tytułowi był potwierdzony, więc naprawiony ręcznie
razem z pozostałymi 26 — **wyłącznie „ł", `-r-40-42` zachowane bez zmian.**

---

## Hipoteza U+00A0 (twarda spacja)

**Policzone bezpośrednio na surowych bajtach UTF-8** zwróconych przez Admin
API (nie na wyświetlanym tekście): **0 z 149 tytułów zawiera znak U+00A0**.
Zero pokrycia ze wzorcem B, bo wzorca B w bieżących danych **nie ma wcale** —
zero przypadków B lub A+B na 149 przebadanych zasobów.

To nie potwierdza hipotezy z promptu na obecnym stanie sklepu. Nie znaczy, że
hipoteza jest błędna w ogóle — mechanizm (twarda spacja po jednoliterowym
wyrazie jako reguła typograficzna, nietraktowana jako separator przy
handleize) jest logicznie spójny i dokładnie tłumaczyłby przykład
`ksiazka-maa-wies-ijej-dzieje` ze zgłoszenia. Ale ten konkretny produkt DZIŚ
ma w tytule zwykłą spację, nie twardą, i handle ma poprawny myślnik
(`i-jej`) — więc albo tytuł został po zgłoszeniu poprawiony (usunięto twardą
spację), albo dane w zgłoszeniu pochodzą sprzed takiej poprawki. Patrz sekcja
„Ważne znalezisko" wyżej.

---

## Podsumowanie liczbowe

| Typ zasobu | Przebadano | Dotkniętych łącznie | A | B | A+B | inne |
|---|---|---|---|---|---|---|
| Produkty | 123 | 30 | 26 | 0 | 0 | 4 |
| Kolekcje | 10 | 3 | 0 | 0 | 0 | 3 |
| Strony | 4 | 1 | 0 | 0 | 0 | 1 |
| Blogi | 1 | 1 | 0 | 0 | 0 | 1 |
| Artykuły bloga | 11 | 8 | 0 | 0 | 0 | 8 |
| **Razem** | **149** | **43** | **26** | **0** | **0** | **17** |

- Zasobów zgodnych z poprawną transliteracją: **106 / 149**.
- Wzorzec A (brak „l"): **26**, wyłącznie produkty.
- Wzorzec B (sklejone wyrazy przez U+00A0): **0** potwierdzonych w obecnych danych.
- Wzorzec A+B: **0**.
- „Inne" (rozstrzygnięte, patrz sekcja „Sekcja «inne»"): **17** — w tym
  4 realne rozjazdy treści niezwiązane z polskimi znakami (zamienione
  handle'e kolekcji i produktów — czekają na klienta / do skasowania przy
  imporcie wydarzeń), 8 celowych krótkich SEO-slugów artykułów (zostają),
  3 systemowe domyślne handle'e Shopify (zostają), 2 ręcznie rozszerzone o
  kod rozmiaru (naprawione co do „ł", rozmiar zachowany).

**Status naprawy: 28/28 wykonane (2026-09-01)** — 26 wzorca A + 2 ręcznie
dopisane ze skarpetek. Zero przekierowań utworzonych (świadomie). Szczegóły
w sekcji „Status naprawy" na górze dokumentu.
