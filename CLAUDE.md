# Majątek Mała Wieś — Shopify theme (Horizon custom)

Sklep: `majatekmalawies.myshopify.com` · Live theme: `192137462093` (NIE pushować bezpośrednio)
Branch roboczy: `zmiany-marek` · Podgląd: `shopify theme dev` → 127.0.0.1:9292

## Kontekst sprintu

Przebudowa strony głównej pod nowy design z Figmy („HOME opcja 1").
Design context (struktura, tokeny, screenshoty z Figmy) dostarcza Ola — nie zgaduj wyglądu,
jeśli brakuje specyfikacji, zapytaj o nią zamiast improwizować.

## Konwencje

- Wszystkie customowe sekcje: prefix `mmw-`, jeden plik = jedna sekcja w `sections/`.
- Schema settings: labelki i defaulty **po polsku**.
- CSS scoping: klasy z prefixem sekcji (np. `.mmw-pc__card`), style w `{% stylesheet %}`
  wewnątrz sekcji; media queries per `#shopify-section-{{ section.id }}` tam, gdzie
  ustawienia sekcji wpływają na layout (wzorzec jak w `mmw-blog-posts.liquid`).
- Fonty przez istniejące zmienne: `--mmw-font-display`, `--mmw-font-label`, `--mmw-font-text`.
- Badge produktowe sterowane TAGAMI (`bestseller`, `nowość`), nie metapolami.
- Metapole opisu na karcie produktu: `product.metafields.custom.opis_karty` (multi-line text).
- Obrazy zawsze przez `image_url` z sensownymi szerokościami + `srcset`; wideo w hero:
  natywne `<video muted playsinline loop autoplay>` z posterem, na mobile fallback do obrazu
  (ustawienie w schema), bez autoplay przy `prefers-reduced-motion`.

## Budżet sekcji tego sprintu — NIE tworzyć sekcji spoza tej listy

Nowe:

1. `mmw-product-carousel` — UNIWERSALNA karuzela produktowa (nagłówek, opis, kolekcja,
   liczba kart, dots, opcjonalna karta końcowa „Zobacz więcej” z linkiem).
   Obsługuje: bestsellery ×2, vouchery, produkty marki. NIE robić osobnych wariantów.
2. `mmw-brand-feature` — split: nagłówek + opis + button + obraz marki.
3. `mmw-split-content` — sekcja obraz + tekst (label, nagłówek, treść).
4. `mmw-newsletter-discount` (robocza nazwa w budżecie: `mmw-klub-newsletter`,
   zmieniona przy realizacji) — form zapisu + checkbox zgody + grafika rabatowa,
   zapis bezpośrednio do Klaviyo. Patrz sekcja `## mmw-newsletter-discount` niżej.
5. `mmw-palac-split` — sekcja Pałacu (label, nagłówek, opis, lista ofert, button, obraz).
6. `mmw-stats` — liczby Majątku (bloki: wartość, sufiks/ikona, opis).
7. `mmw-reviews` — opinie klientów (na start: bloki wpisywane ręcznie; integracja
   z appką opinii w Etapie 2).
8. `mmw-blog-carousel` — karuzela „Opowieści z Winnicy” (karty artykułów).
9. `mmw-product-badges` — badge'y cech produktu (ikona w kolorowym kółku + etykieta),
   źródło: metaobjekt `cecha_produktu`.
10. `mmw-product-assurances` — pasek informacji o dostawie i płatnościach pod przyciskiem
    kupna (treść z ustawień edytora, nie z metapól).
11. `mmw-story-stack` — stos kart przeglądanych swipe'em z automatyczną zmianą (mechanika
    jak Instagram Stories), źródło: metaobjekt `karta_historii`.
12. `mmw-product-story` — dwukolumnowa sekcja: lewa kolumna `mmw-story-stack`, prawa
    kolumna `mmw-sensory-scales` (skale sensoryczne: Wygląd/Aromat/Kwasowość/Ciało),
    źródło: metaobjekty `poziom_skali` / `skala_sensoryczna`.
13. `mmw-product-pairing` — „Polecamy do": kafelki propozycji podania (obraz, tytuł,
    opis), nagłówek/opis z ustawień edytora, źródło kafelków: metaobjekt `polecamy_do`.
14. `mmw-product-recommendations` — „Zobacz także": natywne rekomendacje Shopify
    (related/complementary, wrapper `<product-recommendations>` + lazy-load
    skopiowane verbatim z natywnej `sections/product-recommendations.liquid`,
    `assets/product-recommendations.js` nietknięty), wygląd i karuzela jak
    `mmw-product-carousel`. Karta produktu wydzielona do współdzielonego snippetu
    `snippets/mmw-carousel-card.liquid` (używa jej też `mmw-product-carousel`) —
    NIE mylić z istniejącym, niepowiązanym `snippets/mmw-product-card.liquid`
    (starszy komponent, używany przez `mmw-article-body`/`mmw-article-products`).
15. `mmw-product-seo-faq` — SEO + FAQ na dole strony produktu: lewa kolumna tekst
    SEO (metapole `custom.tekst_seo`, rich text), prawa kolumna akordeony FAQ
    (metaobjekt `pytanie_faq` przez `custom.faq`). Akordeony na natywnym
    `snippets/accordion-custom-component.liquid`. Znika, gdy obie kolumny puste.
16. `mmw-product-video-hero` — pełnoekranowa sekcja wideo "Skąd to pochodzi",
    WYŁĄCZNIE w `templates/product.jedzenie.json` (nie ma jej w `product.wino.json`).
    Treść z ustawień sekcji (bez metafieldów/metaobiektów — wspólna dla wszystkich
    produktów spożywczych). Wideo przez natywny `<deferred-media>`
    (`snippets/video.liquid`, ten sam co natywny `blocks/video.liquid`) — klik
    odtwarza w miejscu, brak autoplay/preload z góry. Figma: node 982:7159.
    Przebudowa:

- `mmw-hero` — obsługa wideo LUB obrazu (media picker), nowy layout.
- `mmw-footer` — nowy design.
- `marquee` — pasek logotypów prasowych (bloki z obrazami, przewijanie).
- UWAGA `mmw-blog-stories`: używa jej też `templates/blog.json` — nie zmieniać jej
  destrukcyjnie; „Opowieści” na głównej robi nowa `mmw-blog-carousel`.

## Czego NIE ruszać w tym sprincie

- Sekcje podstron: `mmw-article-*`, `mmw-blog-hero/posts/tags`,
  `mmw-firms-*`, `mmw-collection-*`, `mmw-history-*`, `mmw-chronicle`, `mmw-heritage-note`,
  `mmw-team`, `mmw-promo-tiles`, `mmw-map`, `mmw-brands`.
- NIE kasować starych sekcji (`mmw-philosophy`, `mmw-stories`, `mmw-video-product`,
  `mmw-how-its-made`, `mmw-instagram`, `mmw-featured-collection`) — sprzątanie to osobne
  zadanie na koniec, po akceptacji nowej strony głównej.
- Eventy/wydarzenia — poza zakresem, wrócą przy stronie wydarzeń.
- WYJĄTEK: `mmw-related-posts` była na tej liście, ale została świadomie ruszona przy
  konsolidacji karty posta bloga (`snippets/mmw-post-card.liquid`, patrz sekcja niżej) —
  zamiana własnego inline markupu karty na wspólny snippet, reszta sekcji (nagłówek,
  layout listy, przycisk) bez zmian.
- WYJĄTEK: mmw-blog-hero, mmw-firms-hero, mmw-history-hero zdjęte z listy
  i scalone z mmw-hero w mmw-page-hero. Powód: różniły się wyłącznie
  prefiksem klas i jedną wartością max-width — utrzymywanie czterech
  kopii tego samego kodu to koszt bez korzyści, a scalanie po dodaniu
  wideo oznaczałoby migrację dwa razy.
- WYJĄTEK: `mmw-process` zdjęta z listy — świadomie przebudowana z jednej
  kolumny richtext na dwie kolumny (Figma node 993-3972), decyzja podjęta
  wprost mimo listy. Stoi wyłącznie na `templates/page.historia.json`
  (przypisanym dziś jako alternatywny szablon strony `/pages/filozofia` —
  handle strony ≠ nazwa pliku szablonu, nie zakładać jednego na podstawie
  drugiego). Nazwa sekcji w edytorze („MMW Proces") celowo NIE zmieniona.
  Ustawienie `text` (jedno richtext pole) zastąpione przez `column_left` +
  `column_right` (też richtext, po prostu dwa zamiast jednego — bez osobnych
  pól na akapity, redaktor wstawia ich dowolną liczbę). Istniejąca treść
  (jeden akapit, ok. 1050 znaków) zmigrowana 1:1 do `column_left` w
  `templates/page.historia.json` (zmiana klucza `text`→`column_left`, treść
  bez zmian) — bez tego strona straciłaby jedyny opublikowany akapit o
  procesie produkcyjnym. `column_right` zostaje puste do wypełnienia przez
  redaktora. Pole `eyebrow` (etykieta nad kolumnami) zostało — id bez zmian,
  tylko label zmieniony na „Nagłówek", więc wartość na stronie przetrwała
  migrację automatycznie.
- WYJĄTEK: `mmw-firms-intro`, `mmw-firms-catalog`, `mmw-firms-contact`,
  `mmw-brands`, `mmw-history-timeline`, `mmw-history-philosophy`, `mmw-team`
  zdjęte z listy WYŁĄCZNIE dla animacji scroll-reveal (patrz
  `## mmw-scroll-reveal`) — decyzja podjęta wprost, żeby `/pages/dla-firm` i
  `/pages/filozofia` nie zostały jedynymi stronami sprintu bez efektu. Zakres
  wyjątku jest wąski: dodany tylko atrybut `data-mmw-reveal` (+ ewentualny
  render wspólnego snippetu stylów/tag skryptu) na już istniejącym markupie —
  ŻADNA inna zmiana wyglądu/treści/logiki tych sekcji. Wszystko poza tym z
  listy „Czego NIE ruszać" nadal obowiązuje bez zmian.
- WYJĄTEK: `mmw-blog-posts`, `mmw-blog-tags`, cały `mmw-article-*`
  (hero/body/products/tags/video/creator) zdjęte z listy WYŁĄCZNIE dla
  animacji scroll-reveal, na wprost polecenie — ten sam wąski zakres jak
  wyjątek wyżej (tylko `data-mmw-reveal`/render/skrypt na istniejącym
  markupie). `mmw-article-hero` dostał ten sam wzorzec `-onload` co
  `mmw-page-hero` (hero zawsze nad zgięciem, tło bez atrybutu, render/script
  PO markupie tła — patrz lekcja o LCP w `## mmw-scroll-reveal`).
  `mmw-blog-grid` i `mmw-blog-stories` NIE były na liście „Czego NIE ruszać"
  (dokładny zapis to `mmw-blog-hero/posts/tags`, nie „grid”/„stories”), więc
  ich dotknięcie nie jest wyjątkiem — zwykła praca w budżecie. Wspólne karty
  (`snippets/mmw-post-card.liquid`, `snippets/mmw-product-card.liquid`)
  dostały atrybut raz, na korzeniu — obejmuje automatycznie wszystkie miejsca
  renderu (odpowiednio: mmw-blog-grid/mmw-blog-posts/mmw-related-posts;
  mmw-article-body/mmw-article-products).

## Zmiany w plikach natywnych Horizona

Konsolidacja karty posta bloga (`snippets/mmw-post-card.liquid`) wymagała edycji
plików natywnych motywu — ryzyko nadpisania przy aktualizacji Horizona:

- `blocks/_featured-blog-posts-card.liquid` — wnętrze zastąpione jednym
  `render 'mmw-post-card'`; schema (ustawienia bloku) celowo NIE wyczyszczona,
  część pól jest już nieużywana (osobny diff porządkowy, jeszcze nie zrobiony).
- `sections/featured-blog-posts.liquid` — TYLKO schema `presets` (3 warianty:
  carousel/grid/editorial), każdy miał zaszyte te same martwe teraz statyczne
  sub-bloki (`title`/`blog-post-info-text`/`blog-post-description`) co punkt wyżej —
  wyczyszczone do `"blocks": {}`, żeby `shopify theme check` (`ValidBlockTarget`)
  nie raportował błędu. Sama logika renderowania sekcji (grid/carousel/editorial,
  `content_for 'block', type: '_featured-blog-posts-card'`) NIE zmieniona.
- `blocks/_blog-post-card.liquid` — planowana, jeszcze nie zrobiona (main-blog.liquid,
  hero na `/blogs/news`).

Osierocone od tej zmiany (nieusunięte, czekają na osobny diff porządkowy):
`blocks/_blog-post-image.liquid`, `blocks/_featured-blog-posts-image.liquid`,
`blocks/_blog-post-info-text.liquid`, `blocks/_blog-post-description.liquid`.

Koszyk dodatków do wydarzeń (Etap 4, `mmw-event-addons`/`mmw-event-cart.js`):

- `templates/cart.json` — dodany JEDEN nowy blok `mmw_cart_addon_grouping_1`
  (`type: mmw-cart-addon-grouping`, patrz `blocks/mmw-cart-addon-grouping.liquid`)
  w sekcji `main-cart`, między istniejącymi static blokami `cart-page-title` i
  `cart-page-items`. Blok narzędziowy — bez własnego widocznego contentu poza
  komunikatem błędu, ładuje `assets/mmw-cart-addon-grouping.js` (sieroty +
  grupowanie wizualne pozycji koszyka). Żaden istniejący blok/setting w pliku
  NIE zmieniony.
- Żaden plik `.liquid` poza `blocks/` (a więc żaden faktyczny natywny render)
  nie został dotknięty — grupowanie w koszyku działa przez `fetch('/cart.js')`
  + istniejący `data-key` na natywnych wierszach (`snippets/cart-products.liquid`
  nieedytowany), usuwanie sierot przez `/cart/change.js` + `morphSection`.
  Ticket na przyszłość, gdyby okazało się za mało: dodanie `data-event-id` wprost
  na `<tr>` w `snippets/cart-products.liquid` (obecnie omijane przez fetch JSON).
- **`assets/mmw-event-cart.js` usuwa w RUNTIME (JS, nie plik) atrybuty
  `on:submit` z `<product-form-component>` i `on:click` z przycisku
  add-to-cart** (`blocks/buy-buttons.liquid` / `snippets/add-to-cart-button.liquid`),
  żeby przejąć submit ticketu+dodatków bez pojedynczego natywnego POST-a i bez
  mylącej animacji "lot do koszyka" przy błędzie 422 — patrz komentarz na górze
  pliku po uzasadnienie (dlaczego nie da się tego zrobić przez wyścig listenerów
  submit/click). **To pierwsze miejsce do sprawdzenia przy aktualizacji
  Horizona** — jeśli zmieni się nazwa/mechanizm atrybutów `on:*`, struktura
  `ProductFormComponent`/`AddToCartComponent`, albo `ref="addToCartButton"`,
  ten hack przestanie działać. Zabezpieczenie: usuwanie atrybutów następuje
  DOPIERO PO podpięciu własnego listenera submit (nie wcześniej) — jeśli ten
  plik się nie załaduje albo coś w nim rzuci wyjątek wcześniej, przycisk
  nadal działa natywnie (sam bilet, bez dodatków), zamiast być martwy.

`assets/base.css`, blok `.page-width-*` (ok. linia 330): nadpisane
`--page-margin` 24px/60px (commit b045008). ŚWIADOMIE zostawione w pliku
natywnym, nie przeniesione do `mmw-tokens.liquid`. Powód: token zużywany
w 15+ miejscach layoutu (grid stron, marquee, natywne sekcje); przy
aktualizacji Horizona chcemy twardego merge conflictu, nie cichej
rozbieżności — gdyby upstream zmienił listę klas `.page-width-*` albo
breakpoint 750px, kopia w mmw-tokens przestałaby pokrywać wszystkie
przypadki BEZ ostrzeżenia (rozjechany layout bez sygnału, skąd pochodzi),
podczas gdy zmiana w base.css i tak wymusi ręczny przegląd przy merge.
Kontrast z `.tax-note.tax-note.tax-note` niżej — tam to sama wizualna
właściwość liścia (font-family), zero zależnych miejsc, więc przeniesienie
było bez ryzyka; tu odwrotnie. Przy każdej aktualizacji Horizona: sprawdzić,
czy upstream nie zmienił listy klas `.page-width-*` ani breakpointu 750px.

`assets/base.css`, `.tax-note.tax-note.tax-note` (natywna reguła Horizona,
`blocks/price.liquid` — cena+podatek pod ceną): `font-family` PRZENIESIONE
do `snippets/mmw-tokens.liquid` (commit 61ac849), base.css nietknięty.
Powód odwrotny niż przy `--page-margin`: to pojedyncza właściwość wizualna
bez zależnych miejsc, więc kopia w mmw-tokens nie ryzykuje cichej
rozbieżności — a mmw-tokens renderuje się w `<head>` PO base.css, więc
przy tej samej specyficzności selektora (0,3,0) wygrywa kaskadą bez
potrzeby edycji pliku natywnego.

`config/settings_schema.json` (globalne ustawienia motywu) — dodana nowa
grupa „MMW — Breadcrumbs" na końcu pliku (dwa ustawienia: mapowanie
marka→kolekcja i lista pomijanych marek, patrz `snippets/mmw-breadcrumbs.liquid`).
Zmiana WYŁĄCZNIE addytywna — żadna istniejąca grupa/ustawienie natywne
nie zostało tknięte, tylko dopisany nowy obiekt na końcu tablicy najwyższego
poziomu. Przy aktualizacji Horizona: sprawdzić, czy upstream nie dodał
własnej grupy na samym końcu pliku w tym samym miejscu (konflikt scalania
przy dopisywaniu na końcu tablicy) — jeśli tak, przenieść naszą grupę,
nie nadpisywać jego.

Linia Omnibusowa (najniższa cena z 30 dni) na bloku ceny strony produktu —
`blocks/price.liquid` i `snippets/price.liquid`, patrz `## mmw-omnibus`
niżej po pełne uzasadnienie:

- `blocks/price.liquid` — jedna dodana linia w istniejącym `render 'price'`
  (`show_omnibus: true`). Nic więcej w pliku nie tknięte, w tym `.tax-note`
  (linia z natywnym `content.taxes_included`) zostaje na swoim miejscu,
  nieprzeniesiona.
- `snippets/price.liquid` — nowy opcjonalny param `show_omnibus` (domyślnie
  false, więc karty produktu/quick-add/hotspot/featured-product, które wołają
  `render 'price'` bez tego parametru, renderują się bez zmian), warunkowe
  `data-mmw-omnibus` na `[ref="priceContainer"]`, markup linii Omnibusowej,
  i scopowany `{% style %}` na dole pliku.

Animacja scroll-reveal (patrz `## mmw-scroll-reveal` niżej) — `sections/marquee.liquid`
to plik NATYWNY Horizona (nie ma prefiksu `mmw-`), zmodyfikowany żeby dodać
`data-mmw-reveal` na `<marquee-component>` + render wspólnego snippetu stylów
+ tag skryptu. Edycja świadomie w zakresie tego sprintu — `marquee` jest na
liście „Przebudowa" w budżecie sekcji wyżej (redesign paska logo), więc dotyk
tego pliku nie jest wyjątkiem wymagającym osobnej zgody, tylko częścią
zaplanowanej pracy. Reszta pliku (mechanika przewijania, `content_for 'blocks'`,
`marquee.js`) nietknięta.

## mmw-omnibus

Najniższa cena z 30 dni (Omnibus) w bloku ceny strony produktu — Figma node
`982-6959`. Zakres tego zadania to WYŁĄCZNIE metapole + render; skąd bierze
się wartość `custom.omnibus` (ręcznie/Flow/cron) to osobna, jeszcze niepodjęta
decyzja.

Metapole: `custom.omnibus`, poziom **PRODUKT** (nie wariant — świadoma
decyzja: żaden produkt w katalogu nie ma dziś wariantów o różnych cenach,
a Omnibus wypełnia się tylko dla produktów aktualnie na promocji, to nie są
dane katalogowe), typ `money`, bez ograniczeń kategorii, Storefront API
access PUBLIC_READ. `.value` zwraca surową liczbę w groszach (jak natywne
`variant.price`) — wymaga `| money`/`| money_with_currency`, nie jest
obiektem z `.amount`/`.currency_code` — zweryfikowane bezpośrednio (tymczasowy
zapis testowy + debug-echo na `theme dev`, oba usunięte zaraz po teście).

Linia renderuje się TYLKO gdy `compare_at_price > price` I metapole
niepuste — bez fallbacku na `compare_at_price`, żadnego „—" przy pustym
polu.

**Dlaczego `blocks/price.liquid` (w tym `.tax-note`) zostaje nietknięty, a mimo
to linia 1 (natywny tekst o podatkach) i linia 2 (Omnibus) renderują się we
właściwej kolejności:** `assets/product-price.js` przy zmianie wariantu
podmienia WYŁĄCZNIE `[ref="priceContainer"]` (Section Rendering API) —
wszystko poza tym `ref`-em zostaje ze starego wariantu. Linia Omnibusowa
musi więc być potomkiem `priceContainer`, czyli fizycznie w
`snippets/price.liquid` — ale to plasuje ją w DOM PRZED `.tax-note` (który
jest sąsiadem `priceContainer`, nie jego potomkiem, renderowanym kawałek
niżej w `blocks/price.liquid`), a spec chce kolejności odwrotnej. Rozwiązanie
bez przenoszenia `.tax-note`:

```css
[data-mmw-omnibus] { display: contents; } /* unwrapuje priceContainer —
  jego dzieci stają się bezpośrednimi flex-itemami <product-price>, obok
  .tax-note, mimo że .tax-note fizycznie zostaje w blocks/price.liquid */
product-price:has([data-mmw-omnibus]) { display: flex; flex-direction: column; }
product-price:has([data-mmw-omnibus]) .tax-note.tax-note.tax-note { order: 1; }
.mmw-omnibus-line.mmw-omnibus-line { order: 2; }
```

`display: contents` na `priceContainer` nie zmienia drzewa DOM (JS-owy
`replaceWith` na tym elemencie działa identycznie), tylko jego udział w
layoutcie — więc `order` „widzi" linię Omnibusową jako flex-item
`<product-price>` na równi z `.tax-note`, mimo że w DOM jest jej wnukiem, nie
dzieckiem.

**Pułapka nr 1 — kombinator rodzeństwa (`~`) NIE działa przez granicę
`display: contents`.** `.mmw-omnibus-line:has(~ .tax-note)` nigdy nie trafia:
selektory (`~`, `+`, `:has()` z nimi) liczą się po prawdziwym drzewie DOM, nie
po layoutowym — a rodzicem `.tax-note` jest `<product-price>`, rodzicem
`.mmw-omnibus-line` jest `priceContainer`. Różni rodzice = nie sąsiedzi,
niezależnie od `display: contents`. Do warunkowego marginesu (10px nad
„blokiem pod spodem" jako całością, 0px między jego dwiema liniami) trzeba
kotwiczyć `:has()` na prawdziwym wspólnym przodku: `product-price:has(.tax-note
:not(:empty))` / `product-price:not(:has(...))`, nie na rodzeństwie.
Zweryfikowane bezpośrednio (CDP, nie teoria) — pierwsza wersja z `~` po prostu
nigdy się nie odpaliła.

**Pułapka nr 2 — dwie ciche natywne reguły z wystarczającą specyficznością,
żeby wygrać z pozornie oczywistym `margin: 0`:** `.tax-note` ma natywny
`margin-top` z base.css (dawał 14px zamiast 10px odstępu od wiersza cen, zanim
złapane przez pomiar `getComputedStyle`, nie zgadywanie); każdy `<p>` wewnątrz
`.text-block` (czyli wewnątrz `<product-price>`) dostaje `margin-block: var(
--font-paragraph--spacing)` z reguły `.text-block p` (specyficzność 0,1,1) —
`.mmw-omnibus-line { margin: 0 }` (0,1,0) przegrywał z nią, trzeba było
`.mmw-omnibus-line.mmw-omnibus-line` (0,2,0). Ten sam wzorzec podwajania
klasy co `.tax-note.tax-note.tax-note` gdzie indziej w tym pliku — **przy
każdej nowej regule nadpisującej natywny element w Horizonie: zmierzyć
`getComputedStyle` po fakcie, nie zakładać, że `margin: 0`/dowolna wartość
„oczywiście" wygra.**

Odstępy w `product-price` idą przez jawny `margin-top` na `.tax-note`/
`.mmw-omnibus-line` (warunkowo, zależnie od tego, czy `.tax-note` renderuje
realną treść), NIE przez `gap` na kontenerze flex — jeden wspólny `gap:10px`
dawałby 10px między KAŻDĄ parą sąsiednich elementów, w tym między linią 1 i 2,
które mają stać ciasno złożone.

`.price`/`.compare-at-price` (36px/24px, `--mmw-font-display`) i wiersz cen
(`flex; align-items: flex-end; gap: 14px`) restylowane WYŁĄCZNIE pod
`[data-mmw-omnibus]`. Kolor (`--mmw-02` na przecenie) jest CELOWO poza tym
zawężeniem — patrz „Regresja i poprawka" niżej po pełne uzasadnienie.

**Regresja i poprawka — `blocks/price.liquid` to nie jest plik strony
produktu, to reużywalny TYP BLOKU.** Pierwsza wersja zakładała (błędnie,
niesprawdzone w Etapie 0), że `blocks/price.liquid` renderuje się wyłącznie
przez `sections/product-information.liquid`, więc bezwarunkowe
`show_omnibus: true` w jego `render 'price'` wydawało się bezpieczne. W
rzeczywistości `blocks/price.liquid` to natywny typ bloku Horizona
(`"type": "price"`), osadzony TAKŻE jako sub-blok `blocks/_product-card.liquid`
— czyli renderuje się na każdej karcie siatki (`templates/collection.json`,
`collection.grid.json`, `search.json`). Efekt: 36px/`--mmw-font-display` i
kolor `--mmw-02` (wtedy jeszcze wpisany w tę samą regułę co typografia)
wyciekły na WSZYSTKIE karty we wszystkich siatkach, a markup linii
Omnibusowej realnie pojawił się na karcie prawdziwego produktu, który akurat
miał wypełnione `custom.omnibus` — potwierdzone na żywo
(`getComputedStyle`/tekst na `/collections/all`), nie tylko w teorii.

Poprawka, dwie oddzielne rzeczy (bo to dwie niezależne osie, mimo wspólnej
przyczyny wycieku):

1. **Zawężenie `show_omnibus`** (`blocks/price.liquid`): zamiast `true` na
   sztywno, `product_resource != blank and product.handle ==
   product_resource.handle` — ten sam wzorzec porównania, jakiego
   `snippets/price.liquid` już używa do `use_currency`. `product` (globalny
   obiekt, aktualnie oglądana strona) różni się od `product_resource`
   (produkt renderowanej karty) na każdej siatce/karuzeli, więc `show_omnibus`
   wychodzi `false` tam, i `true` tylko na faktycznym bloku ceny strony
   produktu. Zero nowych ustawień schematu, zero edycji plików
   `templates/product.*.json`.
2. **Kolor odłączony od `show_omnibus` całkowicie** (`snippets/price.liquid`):
   `color: var(--mmw-02)` usunięty z reguły `[data-mmw-omnibus] .price`
   (typografia), przeniesiony do osobnego, BEZWARUNKOWEGO `{% style %}` na
   samej natywnej klasie `.price-item--sale` (Horizon renderuje ją w DOM
   wyłącznie w gałęzi `show_compare_price` — to już jest istniejący sposób
   sygnalizowania przeceny, żaden nowy warunek Liquid). Powód rozdzielenia:
   kolor ma się pojawiać WSZĘDZIE w stanie przeceny (siatki też), typografia
   TYLKO na faktycznym bloku ceny strony produktu — to dwie różne, niezależne
   decyzje projektowe, nie jedna reguła z dwoma efektami. Świadomie
   zaakceptowana duplikacja: ten mały, zawsze-aktywny blok stylu (1 reguła)
   duplikuje się przy każdym renderze `snippets/price.liquid` (kilkanaście
   miejsc) — nieproporcjonalnie mniejszy koszt niż budowanie osobnego
   mechanizmu współdzielenia dla jednej linii CSS.

Zweryfikowane na żywo po poprawce, nie tylko w teorii: dwa robocze produkty
(status ACTIVE, opublikowane na Online Store wyłącznie na czas testu, potem
usunięte przez `productDelete` — **nie testować cenowych zmian na produktach
z żywego katalogu**, `compare_at_price`/`custom.omnibus` na prawdziwym
produkcie pokazuje nieprawdziwą promocję realnym klientom) — siatka
(kolekcja + wyszukiwarka): produkt bez przeceny w 100% natywny (kolor, 14px,
`DM Sans`), produkt w przecenie: kolor `--mmw-02`, ale WCIĄŻ natywna
typografia siatki (bez 36px, bez `--mmw-font-display`, bez linii Omnibusowej).
Strona produktu: typografia z Figmy zostaje, kolor tylko przy realnej
przecenie (wcześniej: pomarańczowy nawet bez przeceny — to był drugi,
niezależny efekt tej samej pierwotnej pomyłki, złapany dopiero przy
`getComputedStyle` w teście „bez obniżki", nie przy pierwszym wdrożeniu).
Przełączanie wariantów (2-wariantowy roboczy produkt): potwierdzone realne
zastąpienie węzła DOM (`sameNode === false`), linia Omnibusowa i kolor
przetrwały re-render.

## mmw-photo-stack vs mmw-story-stack

`sections/mmw-photo-stack.liquid` (stos zdjęć jako przełącznik tekstu, Figma node
982:7884) to świadoma DUPLIKACJA mechaniki `blocks/mmw-story-stack.liquid`
(wachlarz kart na hover, kolejność kart sterowana `data-depth`/z-index, nie
przestawianiem DOM), a nie jej reużycie ani rozszerzenie. Powody ustalone przed
implementacją (Krok 1):
- auto-advance w Stories jest oparty o pasek postępu (CSS `@keyframes` +
  `animationend`); w photo-stack nie ma paska postępu w Figmie, więc timing
  musi iść przez zwykły `setTimeout`/`clearTimeout` — inny mechanizm u podstaw,
  nie da się podpiąć pod istniejący kod bez przebudowy Stories.
- inny model interakcji: hover nad KONKRETNĄ kartą w stosie promuje ją na
  wierzch (Stories tego nie ma — tam tylko swipe/drag aktywnej karty).
- w photo-stack tekst żyje w osobnym, zsynchronizowanym panelu obok stosu
  (crossfade, `grid-area:1/1` + `[inert]`); w Stories tekst jest wewnątrz
  każdej karty.
- photo-stack ma pełny wzorzec ARIA tablist/tab/tabpanel; Stories przełącza
  `aria-hidden`/`tabindex` bezpośrednio na kartach, bez `tabpanel`.

Nie refaktorować Stories „przy okazji” pod wspólny kod z photo-stack — Stories
jest na produkcji, niepotrzebna destabilizacja działającego komponentu.

**Dług do odnotowania (nie naprawiony, nie do naprawy w tym zadaniu):**
`mmw-story-stack` nie pauzuje auto-advance na focus klawiaturowy — pauza działa
tylko na `:hover`, `[dragging]` i `[out-of-view]` (IntersectionObserver), patrz
`assets/mmw-story-stack.js`/`blocks/mmw-story-stack.liquid`. To realna luka
WCAG 2.2.2 (Pause, Stop, Hide) w komponencie na produkcji — `mmw-photo-stack`
ma pauzę na focus poprawnie zaimplementowaną (multi-reason pause tracker:
hover/focus/viewport), ale Stories jej nie odziedziczyło, bo to duplikacja,
nie wspólny kod.

## Ładowanie JS komponentów mmw-*

Skrypt komponentu (`<script src="{{ 'x.js' | asset_url }}" type="module">`)
ładuje się Z WNĘTRZA sekcji/bloku, który go używa — NIE przez
`snippets/scripts.liquid` (tam idą tylko skrypty faktycznie globalne, potrzebne
na każdej stronie). Powód: samoutrzymujące się — komponent się renderuje, więc
skrypt się ładuje; nie renderuje się nigdzie na stronie, więc nie ładuje się
wcale. Bez listy szablonów do ręcznego aktualizowania przy każdym nowym
umiejscowieniu komponentu (ta pułapka realnie zadziałała: `mmw-photo-stack.js`
i `mmw-story-stack.js` ładowały się globalnie mimo że stoją tylko na wybranych
szablonach produktowych — przeniesione, patrz commit `perf: warunkowe
ładowanie mmw-photo-stack.js i mmw-story-stack.js`).

Gdy komponent ma własny warunek renderowania (np. `mmw-story-stack`:
`{% if stories != blank and story_count > 0 %}`), tag `<script>` idzie
DO ŚRODKA tego warunku, nie przed niego — sam wzorzec co natywne
`blocks/buy-buttons.liquid` (ładuje `local-pickup.js` warunkowo). Gdy
komponent nie ma warunku renderowania (renderuje się zawsze, gdy sekcja/blok
istnieje na stronie), skrypt idzie bezwarunkowo na początku pliku — wzorzec
z natywnej `sections/product-recommendations.liquid` i naszej
`sections/mmw-product-recommendations.liquid`.

Zweryfikowane na żywym renderze (headless Chrome + CDP, nie z dokumentacji):
przeglądarka dedupe'uje moduły ES po URL — kilka instancji tej samej
sekcji/bloku na jednej stronie nie kosztuje dodatkowego requestu ani
ponownego wykonania modułu.

Już zgodne z tą konwencją (nic do przeniesienia): `mmw-event-addons.js` i
`mmw-event-cart.js` (oba z `blocks/mmw-event-addons.liquid`),
`mmw-cart-addon-grouping.js` (`blocks/mmw-cart-addon-grouping.liquid`) —
żaden z nich nigdy nie był w `scripts.liquid`.

## Reużywanie klas CSS z nierenderowanych natywnych snippetów — NIE DZIAŁA na produkcji

**To był realny incydent na produkcji (karuzele: jeden kafelek zajmował 100%
szerokości), nie teoria.** Kilka sekcji mmw-* (`mmw-event-carousel`,
`mmw-product-carousel`, `mmw-product-pairing`, `mmw-product-recommendations`,
`mmw-blog-posts`) reużywało klas `.resource-list__carousel`/
`.resource-list__slide` ze `snippets/resource-list-carousel.liquid` —
ale renderowały karuzelę przez bezpośrednie `render 'slideshow'` +
`render 'slideshow-slide'`, NIGDY `render 'resource-list-carousel'`.

Na `shopify theme dev` to działa — dev serwuje pełny, niepocięty
`compiled_assets/styles.css` (bez parametru `&subset=`). **Na produkcji
Shopify serwuje ten sam plik jako subset liczony PER STRONA** (`?v=...
&subset=<hash>`, inny hash na każdej stronie), najwyraźniej na podstawie
tego, które pliki faktycznie się wyrenderowały w danym żądaniu — NIE na
podstawie tego, jakie klasy CSS występują w gotowym HTML-u. Skoro żadna
z naszych sekcji nie renderowała `resource-list-carousel.liquid`
literalnie, jego `{% stylesheet %}` (w tym `container-type: inline-size` +
`container-name` na `.resource-list__carousel` i oba bloki `@container`
liczące `--slide-width`) nie trafiał do subsetu tych stron na produkcji —
`--slide-width` zostawało niezdefiniowane, `var(--slide-width, 100%)` w
`slideshow-styles.liquid` wchodziło na fallback 100%.

**Naprawa**: `snippets/mmw-carousel-styles.liquid` — snippet zawierający
WYŁĄCZNIE `{% stylesheet %}` z regułami skopiowanymi 1:1 z
`resource-list-carousel.liquid` (bez modyfikacji wartości), renderowany
literalnie (`{% render 'mmw-carousel-styles' %}`) w każdej z pięciu sekcji
wymienionych wyżej — bo o literalny render chodzi subsetterowi.

**Reguła na przyszłość**: jeśli sekcja mmw-* reużywa klasy CSS z natywnego
pliku (Horizon albo naszego), ale NIE renderuje tego pliku literalnie —
to nie zadziała na produkcji, niezależnie od tego, jak dobrze wygląda
na `theme dev`. Albo renderować plik źródłowy literalnie, albo (gdy plik
źródłowy emituje niechciany markup, jak tutaj) wydzielić potrzebne reguły
do osobnego snippetu zawierającego TYLKO `{% stylesheet %}` i renderować
ten literalnie wszędzie, gdzie klasy są używane.

**Kopiuj CAŁY `{% stylesheet %}` źródłowego pliku, nie tylko regułę, która
akurat wywołała widoczny objaw.** Pierwsza wersja `mmw-carousel-styles.liquid`
przeniosła tylko `container-type`/`container-name`/oba `@container` (bo to
one odpowiadały za pierwszy zaobserwowany objaw — kafelek 100% szerokości).
To ukryło DRUGI, osobny bug z tego samego nierenderowanego pliku: reguła
`.resource-list__carousel slideshow-slides { gap: ... }` też została w
`resource-list-carousel.liquid`, więc karty straciły odstęp między sobą —
osobny incydent, wykryty osobno, ta sama przyczyna. Naprawione ostatecznie
kopiując wszystkie 7 bloków reguł 1:1 (w tym reguły częściowo redundantne
względem innych źródeł — redundancja jest tańsza niż kolejne dochodzenie).

**Ostrzeżenia `ValidScopedCSSClass` z `theme check` sygnalizowały dokładnie
ten problem — ale nie każde ValidScopedCSSClass to ten sam problem.**
Ostrzeżenia dla `resource-list__carousel` (pięć sekcji mmw-*) były
zaakceptowanym-błędnie "znanym wzorcem" — to była pomyłka w klasyfikacji,
ValidScopedCSSClass miał rację. Po naprawie (literalny render
`mmw-carousel-styles`) te 5 ostrzeżeń zniknęło samo.

Dla kontrastu: `.details`/`.details__header` w `mmw-product-seo-faq`
(2 ostrzeżenia, wciąż obecne) — SPRAWDZONE na produkcji przez computed
style i realny klik na akordeon (nie przez tekst CSS): działa poprawnie.
Różnica od karuzeli: `mmw-product-seo-faq.liquid:84` renderuje
`accordion-custom-component.liquid` LITERALNIE (`render
'accordion-custom-component'`), więc jego stylesheet trafia do subsetu
normalnie. `.details__header` ma dodatkowo natywną regułę w
`blocks/accordion.liquid` (`.accordion .details__header {...}`), ale ta
wymaga przodka `.accordion`, którego nasz markup nie ma — więc nawet
gdyby ta konkretna reguła wypadła z subsetu, nie miałoby to znaczenia,
bo i tak jej nie używamy (wygląd w całości pokrywa własny
`.mmw-seo-faq__summary`). Wniosek: samo ostrzeżenie ValidScopedCSSClass
NIE wystarcza do diagnozy — trzeba sprawdzić, czy plik źródłowy jest
renderowany literalnie, i czy reguła w ogóle mogłaby dotyczyć naszego
markupu.

**`shopify theme dev` nie odtwarza per-page subsettingu** — nie ma
parametru `&subset=` w ogóle, serwuje pełny bundle zawsze. Testy wizualne
na `127.0.0.1` przed pushem mają ograniczoną wartość dla tej klasy błędów
(brakujące CSS z powodu subsettingu) — jedyna wiarygodna weryfikacja to
pobranie `compiled_assets/styles.css?...&subset=...` bezpośrednio z
produkcji i sprawdzenie, czy potrzebna reguła tam jest.

**Subset przelicza się sam, niezależnie od naszego deploymentu — to
ważniejsze niż sama naprawa.** Podczas diagnozy hash `v=` i `subset=`
w URL-u `compiled_assets/styles.css` zmienił się MIĘDZY dwiema kolejnymi
weryfikacjami na produkcji, mimo że nic nie zostało wypchnięte z naszej
strony w tym czasie. To tłumaczy, dlaczego karuzele mogły wyglądać
poprawnie zaraz po pushu, a zepsuć się dopiero kilkadziesiąt minut
później — **weryfikacja subsetu bezpośrednio po pushu NIE jest
wystarczająca**, bo stan produkcji może się przeliczyć ponownie później
(z niejasnego dla nas powodu — edycja w adminie, rutynowa inwalidacja
cache CDN, coś po stronie Shopify) i akurat wtedy wyrzucić z subsetu
regułę, która wcześniej się w nim znalazła. Jedyna solidna gwarancja to
literalny render pliku/snippetu definiującego potrzebne klasy — nie
poleganie na tym, że subset "akurat" coś złapał przy danym przeliczeniu.

**Dla nowych sekcji mmw-\*: domyślnie `{% style %}` (inline, per-instancja,
nigdy nie trafia do subsetowanego `compiled_assets/styles.css`), nie
`{% stylesheet %}`.** Cała ta klasa błędów znika, jeśli style w ogóle nie
przechodzą przez subsetting. `{% stylesheet %}` ma sens tylko gdy jest
konkretny powód do bundlowania — np. redukcja duplikacji między wieloma
sekcjami reużywającymi tych samych reguł, jak `mmw-carousel-styles.liquid`
wyżej. Wzorzec `{% style %}` już używany w `mmw-firms-catalog.liquid`,
`mmw-footer.liquid`, `mmw-newsletter-discount.liquid`.

## mmw-newsletter-discount

Zapis do newslettera z rabatem — POST bezpośrednio do Klaviyo (client-side
subscribe endpoint), nie przez natywny `{% form 'customer' %}`: flow
powitalny Klaviyo wyzwala się na zapisie do listy Klaviyo, nie na
utworzeniu klienta w Shopify. Pełne uzasadnienie w komentarzu na górze
`sections/mmw-newsletter-discount.liquid`.

Rewizja Klaviyo API (`KLAVIYO_API_REVISION` w `assets/mmw-newsletter.js`) —
Klaviyo wersjonuje po dacie, nie semver; stała ustawiona ręcznie na
`2026-07-15`, bez auto-update. Przy problemach z endpointem (400/415/
nieoczekiwany kształt odpowiedzi) sprawdzić najpierw, czy ta rewizja nadal
żyje: https://developers.klaviyo.com/en/docs/api_versioning_and_deprecation_policy

**Odkryte przy pisaniu tej sekcji, warte zapamiętania przy innych
sekcjach**: `snippets/checkbox.liquid` wypisuje parametr `label` DWA razy
bez escapowania — raz w treści `<span class="checkbox__label-text">`
(bezpieczne dla surowego HTML), ale też w atrybucie
`data-label="{{ label }}"` na samym inpucie (NIEbezpieczne — cudzysłów
z dowolnego `href="..."` w środku przedwcześnie zamyka atrybut i psuje
resztę znacznika `<input>`). Dlatego `mmw-newsletter-discount` NIE
przekazuje richtextowego `consent_text` (z linkiem do polityki prywatności)
jako `label` checkboxa — checkbox dostaje statyczny, niezmienny tekst
"Zgadzam się", a pełna treść zgody (z linkiem) renderuje się osobno, jako
zwykły akapit obok, poza `<label>`. Jeśli kolejna sekcja będzie chciała
wpuścić HTML do `render 'checkbox'`, ta pułapka dotyczy też jej — nie tylko
`checkbox__label-text` trzeba rozważyć, ale i `data-label`.

## Wideo w tle — wzorzec `<source media="...">`, nie CSS display:none

Ustalone przy `mmw-page-hero` (mechanika autoplay wideo w tle + fallback
do obrazu na mobile). Problem: sekcja ma checkbox „na mobile pokaż obraz
zamiast wideo" — pytanie, jak to wymusić bez JS i bez ryzyka, że mobile
i tak pobierze bajty wideo w tle.

**NIE `display: none` w CSS na `<video autoplay>`.** To niepewne —
zachowanie przeglądarek przy pobieraniu/odtwarzaniu ukrytego elementu
`autoplay` nie jest jednoznacznie wyspecyfikowane, w praktyce bywa
niespójne między silnikami.

**Zamiast tego: `<source media="(min-width: 750px)">` na każdym źródle
wideo**, budowane ręcznie z `video.sources` (nie przez filtr `video_tag`,
który nie daje kontroli nad atrybutem `media` per source). To natywny,
udokumentowany mechanizm HTML5 (`media` na `<source>` działa dla
`<video>`/`<audio>` tak samo jak dla `<picture>`) — gdy żadne `<source>`
nie pasuje do bieżącej szerokości viewportu, przeglądarka NIE POBIERA
żadnych bajtów wideo, nie tylko go nie odtwarza. Realna gwarancja
oszczędności transferu, nie heurystyka. Poster (osobny `<img>`, nie
atrybut `poster` na `<video>` — patrz sekcja `## mmw-page-hero` niżej)
zostaje jedyną widoczną warstwą, bez dodatkowej klasy/JS do przełączania.

Wzorzec do skopiowania przy kolejnych sekcjach z wideo w tle:
```liquid
{%- assign source_media = '' -%}
{%- if section.settings.video_mobile_image_fallback -%}
  {%- assign source_media = ' media="(min-width: 750px)"' -%}
{%- endif -%}
<video autoplay muted loop playsinline aria-hidden="true">
  {%- for source in section.settings.video.sources -%}
    <source src="{{ source.url }}" type="{{ source.mime_type }}"{{ source_media }}>
  {%- endfor -%}
</video>
```
`prefers-reduced-motion: reduce` nadal trzeba chować osobno, czystym CSS
(`video { display: none }`) — to inny problem (odtwarzanie, nie transfer
danych) i nie ma dla niego wzorca natywnego w Horizonie (sprawdzone:
`sections/hero.liquid` go nie obsługuje).

## mmw-page-hero

Scalenie `mmw-hero` + `mmw-blog-hero` + `mmw-firms-hero` +
`mmw-history-hero` w jedną sekcję (patrz WYJĄTEK w „Czego NIE ruszać"
wyżej). Pole obrazu ujednolicone na `image` (w `mmw-hero` było
`background_image` — przy migracji `index.json` trzeba przemianować
klucz w `settings`, sama podmiana `"type"` nie wystarczy). `heading_size`
i `heading_line_height` wyprowadzone na ustawienia (były hardkodowane/
różne mechanizmy: `mmw-hero` miał dyskretny suwak px, trio miało płynny
`clamp()`) — przy migracji trio dostaje `heading_line_height: 0.97`
explicité w JSON-ie szablonu, mimo że suwak w schemacie chodzi krokami
0.1 (Shopify: wartość `range` musi być podzielna przez 0.1, więc krok
`0.01` odrzucony przez `theme check`/API — ValidSchema). Liquid i tak
renderuje dosłowną wartość z JSON-a niezależnie od kroku suwaka w
edytorze, więc wartość „między krokami" działa poprawnie, po prostu
suwak w edytorze nie trafi na nią dokładnie przy ręcznej regulacji.

**Otwarta kwestia (nie do naprawy teraz):** `heading_line_height` ma
dwie wartości odziedziczone po scalanych sekcjach (1.1 / 0.97). Do
ujednolicenia po weryfikacji z Figmą.

### mmw-page-hero — leniwe wideo w tle

Wideo w tle blokowało wejście na stronę — pełny stream HLS (manifest +
segmenty, ~12MB dla przykładowego pliku) pobierał się natychmiast przy
`autoplay`, identycznie na desktopie i mobile, bez względu na `preload`.
Przebudowa: cztery pliki (`video_desktop`/`video_mobile`/`poster_desktop`/
`poster_mobile`) zamiast jednego `video`, leniwe ładowanie przez JS.

**Dwa pomiary, które ustaliły architekturę, zweryfikowane bezpośrednio
(Playwright + realny plik HLS z biblioteki Shopify, nie teoria):**

1. **`preload="none"` z `autoplay` NIE działa w ogóle — ale to nie jedyny
   sposób, żeby dostać pełne pobranie.** Zmierzone na izolowanej stronie
   testowej (goły `<video><source src=".m3u8"></video>`, poza sekcją, żeby
   wykluczyć resztę strony jako zmienną) w czterech wariantach naraz —
   `autoplay`+brak `preload`, `autoplay`+`preload="none"`, brak `autoplay`+
   `preload="none"`, brak `autoplay`+brak `preload` (czyli domyślne
   `"metadata"`): pełne ~11,9MB (manifest + segmenty do HD-1080p) pobiera
   się w WARIANTACH 1, 2 I 4 — jedyny wariant z zerowym transferem to
   `preload="none"` BEZ `autoplay` (wariant 3). Innymi słowy: to nie tylko
   `autoplay` „nadpisuje" `preload="none"` (spec to przewiduje) — dla tego
   konkretnego strumienia HLS nawet domyślne `preload="metadata"` BEZ
   żadnego autoplay ściąga pełne segmenty, nie samą zapowiedź/duration jak
   przy zwykłym pojedynczym pliku mp4. Sam atrybut `preload` na statycznym
   znaczniku `<video>` nie daje więc żadnej bezpiecznej kombinacji poza
   „`preload="none"` i zero autoplay" — a nasza sekcja i tak chce
   autoplay. **Jedyny pewny sposób na odłożenie pobierania zostaje ten
   sam: nie dawać `autoplay`/źródeł w znaczniku wcale** — `<video>` w tej
   sekcji teraz nie istnieje w wyrenderowanym HTML-u, tworzy go dopiero
   `assets/mmw-page-hero-video.js` po `requestIdleCallback`.
2. **Dobór bitrate w HLS jest sterowany przepustowością, nie szerokością
   viewportu.** Przy 375px na szybkim łączu (lokalny dev) przeglądarka
   krótko próbkuje wariant SD-480p, po czym eskaluje do HD-1080p —
   dokładnie ten sam plik co na desktopie, mimo małego ekranu. Stąd
   twarda potrzeba osobnego pliku `video_mobile` (nie polegania na tym,
   że HLS „sam się dostosuje” do mobile) — sam plik trzeba wyeksportować
   mniejszy, kod tego nie naprawi.

**Ile faktycznie odracza `requestIdleCallback` — zmierzone pod dławieniem
sieci i zajętym wątkiem głównym, nie na cichym tabie.** Pierwszy pomiar tej
architektury (Playwright, zero throttlingu, pusta karta bez konkurencji o
wątek główny) pokazał `requestIdleCallback` odpalający się ~45ms po
zarejestrowaniu, `didTimeout: false` (prawdziwa bezczynność) — czyli PRZED
zdarzeniem `load`, praktycznie natychmiast. To najlepszy możliwy scenariusz
i nie pokazuje żadnej realnej różnicy względem starego kodu. Powtórzone pod
`Emulation.setCPUThrottlingRate: 4` + wstrzykniętą pracą wątku głównego co
30ms (symulacja trackerów/hydration na prawdziwej stronie) + throttling
sieci (`Network.emulateNetworkConditions`, dwa profile: Fast 3G — 1,6Mbps↓/
750Kbps↑/150ms RTT, i Slow 4G — 4Mbps↓/3Mbps↑/170ms RTT), mobile 375px:

| Profil | STARY kod — start pobierania wideo | NOWY kod — start pobierania wideo | `load` |
|---|---|---|---|
| Slow 4G + zajęty wątek | **4,06s** (przed `DOMContentLoaded`@6,75s) | **10,50s** (po `load`) | stary: 8,07s / nowy: 7,64s |
| Fast 3G + zajęty wątek | **9,04s** (przed `DOMContentLoaded`@16,46s) | **17,71s** (po `load`) | stary: 16,97s / nowy: 16,29s |

Stary kod (`<video autoplay>` literalnie w HTML-u) zaczyna ściągać wideo
ZANIM przeglądarka skończy parsować własny DOM strony — konkuruje o
przepustowość z krytycznymi zasobami strony przez kilka-kilkanaście sekund.
Nowy kod w obu profilach czeka do PO `load`. W obu profilach
`requestIdleCallback` odpalił się przez fallback timeoutu
(`didTimeout: true, timeRemaining: 0`), nie przez prawdziwą bezczynność —
przy stale zajętym wątku głównym (pętla 25ms pracy / 30ms przerwy, ~45%
obciążenia) przeglądarka nigdy nie znalazła realnej szczeliny bezczynności
w ciągu 4s, więc callback odpalił się dokładnie ~4000ms po wywołaniu
`requestIdleCallback`, nie wcześniej i nie później. Wniosek: to NIE jest
nieograniczone odroczenie do „prawdziwej" bezczynności — to twardy odstęp
~4s od momentu wykonania skryptu, niezależnie od realnej bezczynności wątku,
gdy wątek jest stale zajęty. Pod dławieniem sam skrypt modułowy wykonuje się
też później niż na cichym tabie (6,3s przy Slow 4G, 13,6s przy Fast 3G —
tyle trwa ściągnięcie i sparsowanie reszty strony), więc całkowite
opóźnienie startu wideo to suma: (czas do wykonania skryptu) + (do 4s
timeoutu `requestIdleCallback`) — w obu zmierzonych profilach to
wystarczyło, żeby wylądować PO `load`, ale przy szybszym połączeniu
(pierwszy pomiar, bez throttlingu) skrypt wykonuje się na tyle szybko, że
nawet pełne 4s nie byłyby potrzebne — bezczynność znajduje się naturalnie w
ułamku sekundy, i wtedy przewaga nad starym kodem jest minimalna albo
żadna. Innymi słowy: **to odroczenie ma sens dokładnie na wolnych/zatłoczonych
urządzeniach, które są tu głównym celem** — na szybkim, cichym urządzeniu
deweloperskim korzyść w praktyce znika, bo stronie i tak nie ma na co czekać.

**`<source media="...">` wewnątrz `<video>` DZIAŁA poprawnie** — wbrew
częstemu przekonaniu (i wbrew treści promptu, który zlecił tę przebudowę).
Zweryfikowane bezpośrednio w trzech silnikach (Chromium, Firefox, WebKit —
zainstalowane specjalnie do tego testu), viewport dopasowany i niedopasowany
do `media`: zero requestów wideo/HLS gdy `media` nie pasuje, we wszystkich
trzech. Mechanizm wyboru pliku w tej sekcji i tak przeniesiony do JS
(`matchMedia`), ale NIE dlatego że `<source media>` nie działa — dlatego że
i tak potrzebny jest JS do odłożenia startu pobierania (`requestIdleCallback`),
więc dublowanie logiki wyboru pliku w HTML i JS nie miałoby sensu. Gdyby
kiedyś ktoś inny w motywie chciał czystego HTML-owego przełącznika źródła
wideo bez JS (np. dla accessibility/no-JS budżetu) — `<source media>` jest
opcją, nie ślepym zaułkiem.

Kolejność: `preload="none"` też sprawdzony jako nieskuteczny osobno (patrz
wyżej) — architektura nie polega na atrybucie `preload` w ogóle, tylko na
nieobecności `<video>` w znaczniku do czasu, aż JS go utworzy.

**`playing`, nie `loadstart`/`canplay`, jako sygnał podmiany plakat→wideo**
— gwarancja realnego odtwarzania, nie tylko że dane zaczęły napływać.
Crossfade przez `opacity` + `transition`, klasa `.mmw-page-hero--video-ready`
dodawana na `<section class="mmw-page-hero">` — **UWAGA na selektor CSS przy
kolejnych zmianach w tym pliku**: `#shopify-section-{{ section.id }}` to
zewnętrzny wrapper generowany przez Shopify, NIE ten sam element co
`.mmw-page-hero` (klasa jest na elemencie `<section>` W ŚRODKU wrappera).
Pierwsza wersja selektora `#shopify-section-{{ id }}.mmw-page-hero--video-ready
{ ... }` (złożony, bez spacji) nigdy się nie odpalała — złapane dopiero przy
bezpośrednim sprawdzeniu `getComputedStyle` (wideo grało, `currentTime` rosło,
klasa była obecna, ale opacity zostawało na 0). Poprawny selektor to
potomkowy: `#shopify-section-{{ id }} .mmw-page-hero.mmw-page-hero--video-ready
.mmw-page-hero__bg-video`.

`| json` na `video.sources` (cały obiekt VideoSource drop) rzuca **"json not
allowed for this object"** — zweryfikowane bezpośrednio, nie teoria. Dane do
JS (dwie listy źródeł wideo) budowane ręcznie przez `capture` + `for`, pole
po polu (`source.url`/`source.mime_type` to zwykłe stringi, `| json` na nich
działa poprawnie) — nie przez zrzucenie całego `.sources` na raz.

Poster: `<picture><source media="(max-width: 749px)">` dla mobile, nie
`srcset`/`sizes` — to dwa różne kadry (inna kompozycja mobile/desktop), nie
ta sama grafika w innej rozdzielczości, więc semantycznie to przypadek dla
art-direction (`picture`+`media`), nie resolution-switching (`srcset`).
WebP potwierdzone jako automatyczne po stronie CDN Shopify (bez żadnej
konwersji z naszej strony) — zmierzone bezpośrednio: PNG (`MMW_pejzaz.png`)
wraca z nagłówkiem `content-type: image/webp` bez żadnej zmiany po naszej
stronie.

**Waga postera zależy od konkretnego pliku, nie tylko od kodu.** Cel z
zadania to ~150KB; zmierzony realnie plakat desktopowy (`MMW_pejzaz.png`,
szerokość 2400px) waży 321,5KB — krajobrazowe zdjęcie o dużej złożoności,
nie dobrane pod limit wagowy. Kod dostarcza WebP automatycznie i dwa
kandydaty szerokości (1200w/2400w), ale nie wymusi wagi poniżej progu, gdy
samo źródło jest ciężkie do skompresowania — to decyzja o konkretnym pliku,
nie coś do naprawienia w Liquid/CSS.

Rename ustawień przy tej przebudowie (Shopify: `visible_if` to tylko UI
edytora, nie chroni przechowanej wartości — stare klucze w istniejących
instancjach trzeba było ręcznie przepisać w JSON-ach szablonów, sama zmiana
schematu by tego nie zrobiła):
- `video` → `video_desktop` (ten sam typ `video`, ta sama wartość).
- `video_mobile_image_fallback` (domyślnie `true` = **chowaj** wideo na
  mobile) → `show_video_mobile` (domyślnie `true` = **pokazuj** wideo na
  mobile) — odwrócona semantyka domyślnej wartości, nie tylko nazwa.
  `templates/index.json` (jedyna instancja z realnie aktywnym wideo w
  momencie przebudowy) miało `video_mobile_image_fallback: false` (wideo
  pokazywane na mobile) → zmigrowane na `show_video_mobile: true` (to samo
  zachowanie, odwrócona wartość logiczna zgodnie z odwróconą semantyką).
  Orphaned klucz `video_mobile_image_fallback: true` w `page.historia.json`
  (bez aktywnego wideo, `background_type: image`) usunięty przy migracji —
  nie miał żadnego efektu, ale zaśmiecał JSON martwym ustawieniem.

## mmw-scroll-reveal

Globalna animacja "podjazd + wygaszenie" dla bloków wchodzących w viewport
przy scrollu (`translateY(24px)→0` + `opacity 0→1`, 450ms ease-out, stagger
~80ms/blok w obrębie sekcji, sufit po 5. bloku). Mechanika:
`assets/mmw-scroll-reveal.js` (jeden globalny `IntersectionObserver`, nie
jeden na sekcję/blok — dedupe modułu ES po URL jak przy innych mmw-*.js) +
`snippets/mmw-scroll-reveal-styles.liquid` (`{% style %}`, renderowany
literalnie z każdej uczestniczącej sekcji, wzorzec 1:1 z
`mmw-carousel-styles.liquid`). Stan początkowy (`opacity:0`) nadaje WYŁĄCZNIE
JS (atrybut `data-mmw-reveal-pending`) — bez wykonania skryptu żaden element
nigdy go nie dostaje, strona wygląda normalnie.

**Pułapka IntersectionObserver przy szybkim/skokowym scrollu — zweryfikowana
bezpośrednio (Playwright, `window.scrollTo` z `behavior: 'auto'` na sam dół
strony), nie teoria.** Element, który w JEDNEJ klatce przeskakuje z „jeszcze
przed viewportem" na „już za viewportem" (bo scroll skoczył bezpośrednio na
nową pozycję, bez renderowania pozycji pośrednich), nigdy nie przecina progu
przecięcia (ratio idzie 0%→0%) — obserwator w ogóle NIE dostaje wywołania dla
tego targetu, więc żaden warunek wewnątrz jego callbacku (np. sprawdzenie
`boundingClientRect.top < 0` przy `isIntersecting: false`) nigdy się nie
wykona. Pierwsza wersja tej ochrony (wewnątrz callbacku obserwatora) nie
działała z dokładnie tego powodu — potwierdzone: 15 bloków zostawało trwale
`opacity:0` po `window.scrollTo` na dół. **Rozwiązanie musi żyć POZA
callbackiem obserwatora**: dodatkowy `scroll` listener (passive, throttled
przez `requestAnimationFrame`) sam sprawdza pozycje pozostałych elementów w
`pendingSet` — te same kryteria co przy klasyfikacji startowej („już nie jest
poniżej fold-a" obejmuje zarówno „widoczny", jak i „już minięty"). Po
poprawce: 0 zawieszonych elementów, zweryfikowane tym samym testem aż do
faktycznego dołu strony.

**`data-mmw-reveal-onload`** — druga, dopisana gałąź w `init()` dla treści
zawsze na pierwszym ekranie (dziś: tylko `mmw-page-hero` — logo/nagłówek/
podtytuł/przyciski), która MA się animować mimo że nigdy nie "wchodzi" przez
scroll (zwykły `data-mmw-reveal` klasyfikowałby ją jako "już widoczna" i
pomijał animację, patrz klasyfikacja startowa wyżej). Animuje się natychmiast
przy starcie strony, przez ten sam stagger per `.shopify-section` i tę samą
`animateIn()` — reszta mechaniki (IntersectionObserver, scroll-sweep) nie
tknięta. Tło hero (obraz/wideo/plakat, kandydat LCP) świadomie NIGDY nie
dostaje tego atrybutu.

**Kolejność tagów w dokumencie ma znaczenie dla LCP, nawet przy
`type="module"`.** Pierwsza wersja umieszczała `{% render
'mmw-scroll-reveal-styles' %}` + `<script src="mmw-scroll-reveal.js">` NA
GÓRZE `mmw-page-hero.liquid`, przed `<section>` (czyli przed obrazem tła z
`fetchpriority="high"`). Zmierzone: LCP desktop ~530ms (mean z kilku
pomiarów) vs ~431ms na kodzie sprzed tej zmiany — realny, choć skromny,
regres. Skaner preloadera przegląda zasoby w kolejności ODKRYCIA w dokumencie,
nie w kolejności `fetchpriority` same w sobie — wcześniej odkryty `<script
type="module">` (mimo że deferred, nie blokuje renderu) i tak konkuruje o
wczesne pasmo/kolejkę pobierania z high-priority obrazem tła odkrytym po nim.
Poprawka: przeniesienie render+script ZA markup tła (przed
`.mmw-page-hero__overlay`) — LCP wróciło bliżej baseline (mean ~490-526ms w
kolejnych seriach pomiarów, mobile bez różnicy: ~426ms po vs ~449ms przed).
Niewielka rozbieżność między seriami pomiarów na desktopie mieści się w
naturalnym szumie tego środowiska (pojedyncze pomiary wahały się nawet o
~140ms między identycznymi powtórzeniami tego samego kodu) — nie
wyeliminowana całkowicie, ale nieproporcjonalna do dalszej inżynierii bez
twardszego środowiska pomiarowego. **Reguła na przyszłość**: nowy `<script>`/
`{% render %}` w sekcji z kandydatem LCP idzie PO markupie tego kandydata w
dokumencie, nie przed nim, nawet jeśli logicznie "powinien" być na górze pliku.

**Błysk treści (FOUC) — "widoczne → znika → wjeżdża od nowa".** Przyczyna
zmierzona wprost (MutationObserver z zewnątrz, obserwujący moment nadania
atrybutów `data-mmw-reveal-pending`/`-in`, zestawiony z `performance.getEntriesByType('paint')`,
na rzuconej sieci Slow 4G + pusty cache): pierwsze malowanie w ~4048ms
(desktop) / ~3592ms (mobile), ale `assets/mmw-scroll-reveal.js` (moduł,
deferred) dostawał szansę oznaczyć elementy dopiero w ~6174ms / ~5714ms —
**treść była w pełni widoczna przez ~2.1s**, zanim skrypt ją schował
(elementy poniżej zgięcia) albo wrzucił w środek animacji wejścia (hero,
`-onload`, zawsze nad zgięciem) — dotyczyło OBU kategorii, różnym wariantem
tego samego błędu (dopiero co potwierdzone, nie hipoteza). Bardzo prawdopodobnie
to był też realny mechanizm za nieodtworzonym "przeskakiwaniem obrazów w
kaflach karuzeli" opisanym wcześniej — szybki cykl widoczne→schowane→animacja
na normalnej (nierzuconej) sieci mógł wyglądać jak jednorazowy skok, nie jak
osobny błąd geometrii (pomiar pikselowy z poprzedniej tury nie znalazł żadnego
przesunięcia obrazu względem kafla — to przemawia za tą hipotezą, nie
przeciw niej).

Poprawka — wzorzec klasy `no-js`, ten sam od lat używany w motywach:
- **Krótki, BLOKUJĄCY inline `<script>`** (bez `type="module"`, bez
  `defer`/`async`) w `snippets/mmw-tokens.liquid` — CELOWO tam, nie w nowym
  pliku renderowanym z `layout/theme.liquid`: `{% render 'mmw-tokens' %}` już
  tam istnieje sprzed tej zmiany, więc dopisanie linii W ŚRODKU tego snippetu
  nie wymagało w ogóle dotykania pliku natywnego. Jedna linia kodu:
  `document.documentElement.classList.add('mmw-reveal-ready');` — wykonuje
  się synchronicznie podczas parsowania `<head>`, więc przed pierwszym
  malowaniem, niezależnie od tego, kiedy zdąży wykonać się deferred moduł.
- CSS w `mmw-scroll-reveal-styles.liquid` przepisany na
  `.mmw-reveal-ready [data-mmw-reveal] { opacity: 0; ... }` — `data-mmw-reveal`
  jest atrybutem STATYCZNYM z Liquid (obecnym od razu w wyrenderowanym
  HTML-u, nie dodawanym przez JS), więc ta reguła aktywuje się od pierwszego
  malowania, zamiast czekać, aż moduł doda `-pending`. Bez JS w ogóle: klasa
  `.mmw-reveal-ready` nigdy nie trafia na `<html>`, reguła nigdy nie
  dopasowuje, cała treść normalnie widoczna — warunek z poprzedniej tury
  nienaruszony.
- Konsekwencja w `assets/mmw-scroll-reveal.js`: gałąź "już widoczne przy
  starcie, pomiń animację" MUSIAŁA dostać jawne oznaczenie
  (`data-mmw-reveal-shown`, przywraca `opacity:1` bez `animation`) — pod
  nową, domyślnie-schowaną architekturą samo `continue` (jak wcześniej)
  zostawiłoby te elementy niewidoczne na stałe, bo nic by ich nigdy ponownie
  nie odkryło (nie są obserwowane). To jedyna zmiana w logice modułu;
  obserwator, stagger i scroll-sweep fallback nietknięte.
- `@media (prefers-reduced-motion: reduce)` z `!important` na gołym
  `[data-mmw-reveal]` (bez wymogu `.mmw-reveal-ready`) — celowo bezwarunkowy:
  moduł pod reduced-motion przerywa `init()` na starcie bez oznaczania
  czegokolwiek, więc bez tego override'u i bez modułu (błąd sieci, blokada)
  treść zostałaby ukryta na stałe mimo reduced-motion.

Zweryfikowane po poprawce (polling `getComputedStyle(...).opacity` co 200ms,
niezależnie od czasu wykonania modułu): `.mmw-reveal-ready` na `<html>` już w
~1.6s (długo przed pierwszym malowaniem ~4s), elementy `data-mmw-reveal`
nigdy nie pokazują się w stanie widocznym przed zamierzoną animacją —
`opacity` idzie `null` (jeszcze nie sparsowany) → `0` (poprawnie schowany) →
rośnie płynnie do `1` przez keyframe. Zero błysku, potwierdzone na obu
viewportach i na `/pages/dla-firm`/`/pages/filozofia`.

**LCP po poprawce FOUC — realny, ale asymetryczny koszt.** Desktop bez
zmian: ~628-643ms (mean, z i bez blokującego skryptu — różnica w granicach
szumu). Mobile: ~451ms bez skryptu → ~552ms z skryptem (8 próbek), różnica
rzędu 100ms, powtarzalna w większej próbie, ale bez wskazywalnego mechanizmu
przyczynowego — sam dodany kod to jedna linia inline, zero zasobów
zewnętrznych, Liquid `{% comment %}` (opis nad skryptem) nie trafia do
wyrenderowanego HTML-a w ogóle. Zgłaszane wprost, nie ukrywane: hipoteza to
mniejsza waga strony mobile (plakat 750w ściąga się szybko), więc ten sam
stały narzut widać tam proporcjonalnie mocniej niż na cięższym, wolniejszym
renderze desktopowym — nieprzetestowana dalej, bo wymagałaby twardszego
środowiska pomiarowego niż lokalny `theme dev` w headless Chromium. Względem
ZUPEŁNIE oryginalnego baseline sprzed całej funkcji scroll-reveal
(431ms/449ms): skumulowany koszt to +~200ms desktop, +~100ms mobile.

## mmw-stats

Animacja odliczania (`assets/mmw-stats.js`) renderuje liczby bez separatora
tysięcy, tak samo jak Liquid dziś ("5000+", nie "5 000+") — gdyby kiedyś
doszło polskie formatowanie tysięcy, trzeba je dodać JEDNOCZEŚNIE w Liquidzie
i w JS, inaczej liczba „skoczy" szerokością na starcie i końcu animacji.

## mmw-collection-seo-faq vs mmw-product-seo-faq — ŚWIADOMA duplikacja markupu

`sections/mmw-collection-seo-faq.liquid` (SEO + FAQ na stronach kolekcji,
`enabled_on: collection`) czerpie z `collection.metafields.custom.seo_tekst`
(rich text) i `collection.metafields.custom.faq` (lista referencji do
metaobjektu `pytanie_faq` — **ten sam typ co na produktach**, zweryfikowane
przez Admin API: identyczny `MetaobjectDefinition` po obu stronach, wspólna
pula pytań). Klucz metapola SEO ma odwrotną kolejność członów względem
produktu: `custom.seo_tekst` (kolekcja) vs `custom.tekst_seo` (produkt) —
łatwo pomylić przy kopiowaniu.

**Markup pojedynczego pytania FAQ (accordion-custom-component + klasy
`.mmw-seo-faq__*`/`.details`/`.details__header`) i cały CSS istnieją w DWÓCH
NIEZALEŻNYCH plikach — `mmw-collection-seo-faq.liquid` i
`mmw-product-seo-faq.liquid` — skopiowane 1:1, celowo NIE wydzielone do
wspólnego snippetu.** Decyzja: wspólny snippet, z którego korzystałby tylko
jeden z tych dwóch plików (bo plik produktowy trzyma własny `{% stylesheet %}`
i nie ma dziś zgody na jego refaktor), dawałby fałszywe poczucie wspólnego
źródła prawdy — ktoś poprawiłby snippet, zobaczył efekt na kolekcji i uznał
sprawę za załatwioną na produkcie też. **Zmiana wyglądu lub zachowania
akordeonu pytania w jednym z tych plików wymaga ręcznego powielenia zmiany
w drugim** — nic tego nie wymusi automatycznie. Prawdziwa konsolidacja
(np. wspólny snippet renderowany literalnie przez oba pliki, z refaktorem
`mmw-product-seo-faq.liquid`) to osobne zadanie, wymaga osobnej zgody.

Różnica zachowania między plikami, świadoma: pytanie z pustą odpowiedzią —
produktowy komponent renderuje pusty, klikalny akordeon; kolekcyjny **pomija
całe pytanie**. Nie ujednolicone celowo, nie przeoczone — ALE to oznacza,
że komponent produktowy ma tu drobny, realny błąd (pusty akordeon nie
powinien się renderować), teraz opisany, jeszcze nie naprawiony.

**Dług do naprawy w `mmw-product-seo-faq.liquid` (jedno zadanie, osobna
zgoda, dwie rzeczy naraz — świadomie trzymane razem, nie osobno):**
1. Pomiń pytanie z pustą odpowiedzią (`answer != blank`) zamiast renderować
   pusty akordeon — dokładnie warunek już użyty w
   `mmw-collection-seo-faq.liquid`.
2. `{{ answer }}` wypisuje `odpowiedz.value` (metaobjekt `pytanie_faq`, pole
   `multi_line_text_field`) bez `| newline_to_br` — wieloakapitowe/wielolinijkowe
   odpowiedzi renderują się jako jeden zlepiony blok tekstu (`white-space:
   normal`, brak `<br>`/`<p>` w źródle). **Nie teoria — zweryfikowane na
   żywo**: 2 z 115 odpowiedzi w banku FAQ zawierają `\n`
   (`jak-wyglada-zwiedzanie-winnicy`, `dla-kogo-jest-to-doswiadczenie`), i
   pierwsza z nich jest DZIŚ używana na 3 realnych produktach
   (`zwiedzanie-winnicy`, `zwiedzanie-winnicy-copy`, `degustacje-wina-copy`)
   — błąd jest aktualnie widoczny na produkcji/theme dev, nie hipotetyczny.
   Potwierdzone przez `innerText` w headless Chrome (nie przez czytanie
   źródła HTML), na `mmw-collection-seo-faq.liquid`, które ma ten sam
   problem (skopiowany 1:1) — naprawa musi objąć oba pliki.

`shopify theme check` raportował ~16 ostrzeżeń `ValidScopedCSSClass` na
`mmw-collection-seo-faq.liquid` dla klas współdzielonych nazewniczo z plikiem
produktowym (`.mmw-seo-faq__*`) i natywnych (`.details`/`.details__header`).
Fałszywy alarm z innego powodu niż zwykle w tym projekcie: te klasy są
zdefiniowane w tym samym pliku, w `{% style %}` — a `{% style %}` (w
odróżnieniu od `{% stylesheet %}`) renderuje się jako inline `<style
data-shopify>` bezwarunkowo przy każdym renderze sekcji, nigdy nie wchodzi
do subsetowanego `compiled_assets/styles.css`, więc problem z „Reużywanie
klas CSS z nierenderowanych natywnych snippetów" opisany wyżej w tym pliku
strukturalnie nie może tu wystąpić. **Wyciszone** przez `{% #
theme-check-disable ValidScopedCSSClass %}` / `{% # theme-check-enable
ValidScopedCSSClass %}` wokół bloku markupu (wzorzec już używany w natywnych
plikach Horizona, np. `blocks/_heading.liquid`, `blocks/_product-media-
gallery.liquid` — nie wymyślony na potrzeby tego pliku) — świadomie NIE przez
nowy `.theme-check.yml` (rozważane, odrzucone: reguła per-plik przez YAML
zmieniałaby zachowanie checkera dla całego repo, podczas gdy dyrektywa inline
jest zawężona dokładnie do tego jednego bloku i widoczna w tym samym miejscu,
co jej uzasadnienie). Po wyciszeniu: `theme check` z powrotem na baseline
32/2/30, potwierdzone przed i po.

## sizes/srcset przy object-fit: cover — dwie pułapki (mmw-blog-grid)

Ustalone przy diagnozie rozmazanych obrazów w `mmw-blog-grid.liquid` (karta
`snippets/mmw-post-card.liquid`, współdzielona też z `mmw-blog-posts` i
`mmw-related-posts`) — pierwsza tura diagnozy dała fałszywy wniosek („1 z 8
obrazów za mały"), poprawiony dopiero w drugiej turze na „6 z 8" po
uwzględnieniu poniższej pułapki nr 2. Kosztowało to całą turę błędnej
diagnozy — warto to sprawdzać od razu przy każdym kolejnym `object-fit: cover`.

**Pułapka 1 — `img.naturalWidth`/`naturalHeight` są NIEWIARYGODNE przy
`srcset` z deskryptorami `w`.** Dla obrazu z `srcset="...400w, ...900w"` te
właściwości NIE zwracają surowych wymiarów pobranego pliku — przeglądarka
koryguje je względem gęstości: `naturalWidth = realny_szerokość_pliku /
(wybrany_deskryptor_w / efektywna_wartość_sizes)`. Zweryfikowane bezpośrednio
(izolowany plik HTML, identyczny URL z i bez `srcset` — różne `naturalWidth`
dla dokładnie tych samych bajtów). Do pomiaru realnej rozdzielczości
dostarczonego pliku: `fetch(img.currentSrc)` → `blob` →
`createImageBitmap(blob)` → `.width`/`.height` — to jedyny sposób, który nie
kłamie. Samo `curl` na URL też nie wystarcza do porównania z tym, co widzi
przeglądarka — CDN Shopify negocjuje format przez `Accept` (`curl` bez
nagłówka dostaje JPEG, Chrome dostaje WebP na tym samym URL-u); wymiary są
identyczne w obu formatach, ale warto pamiętać przy debugowaniu przez `curl`,
że trzeba dodać `-H "Accept: image/webp,..."`, żeby zobaczyć to, co faktycznie
widzi przeglądarka.

**Pułapka 2 — przy `object-fit: cover` zapotrzebowanie na piksele liczy się
od wymiaru WIĄŻĄCEGO kadru, nie od szerokości kontenera.** Jeśli karta jest
pionowa (tu: 331/507) a źródłowy obraz poziomy, `cover` skaluje obraz tak, by
pokrył WYSOKOŚĆ karty — widoczna jest tylko środkowa część, ale renderowana
(i pobierana) szerokość jest znacznie większa niż szerokość kolumny w
layoucie. Wzór na potrzebną szerokość źródła:
`karta_wysokość_css × DPR × (źródło_szerokość / źródło_wysokość)`, NIE
`kolumna_szerokość_css × DPR`. Naiwne liczenie `sizes` od szerokości
kontenera (tak jak przy zwykłym, niekadrowanym obrazie) systematycznie
zaniża zapotrzebowanie dla każdego źródła szerszego niż proporcja karty —
im bardziej poziomy obraz, tym większy błąd (przy 331:507 i źródle 16:9 to
prawie 3× różnicy, nie kilka procent).

**Konsekwencja implementacyjna, osobno zweryfikowana**: `sizes="auto, ..."`
(Chrome, `loading="lazy"`) liczy się z realnego pudełka CSS elementu
`<img>` (u nas 100%/100% karty), NIE z efektywnie większego rozmiaru
wynikającego z `cover` przy niepasującej proporcji źródła — więc "auto"
całkowicie IGNORUJE każdy mnożnik dopisany w dalszej części `sizes`.
Zweryfikowane bezpośrednio: z `"auto, ..." ` na początku przeglądarka mimo
poprawnego mnożnika w formule dalej wybierała ten sam (za mały) kandydat
`srcset`, jakby mnożnika nie było. Żeby korekta pod `cover` faktycznie
zadziałała w Chrome, `sizes` przekazywany do karty w takim kontekście MUSI
pomijać prefiks `"auto,"` — dokładnie ten sam wyjątek co przy
`loading="eager"`, opisany już w doc-commencie `mmw-post-card.liquid`, tylko
z innego powodu (tam: spec wymaga braku "auto" przy eager; tu: "auto" i tak
zignorowałby świadomy mnożnik pod cover).

## Workflow

- Commit po każdej ukończonej sekcji, komunikaty po polsku, np. `feat: mmw-stats — liczby Majątku`.
- `templates/index.json` przepinać na nowe sekcje dopiero, gdy sekcja jest gotowa i sprawdzona
  na 127.0.0.1:9292 (desktop + mobile 375px).
- Push wyłącznie na theme dev/unpublished; publikacja na live tylko na wyraźne polecenie Oli.
- Dane katalogowe (produkty, metapola, kolekcje) NIE mają stagingu — zmiany w adminie są
  natychmiast live. Definicje metapól i tagi można dodawać bezpiecznie; niczego nie nadpisywać
  ani nie usuwać bez potwierdzenia.

## scripts/

Katalog `scripts/` zawiera narzędzia poza theme'em: skrypty importowe
(Admin API / Matrixify) oraz ich pliki danych (np. `sensoryka-dane.json`
— kanoniczne definicje skal sensorycznych). Shopify CLI ignoruje ten
katalog przy `theme push` i `theme dev`, więc nic stąd nie trafia na
sklep jako plik theme'u. Nie umieszczaj tu assetów theme'u ani nie
odwołuj się do tych plików z Liquid. Skrypty operujące na danych
katalogowych (metaobiekty, metafieldy) muszą być idempotentne
(upsert po handle) i mieć domyślny tryb `--dry-run` — dane katalogowe
nie mają warstwy staging i idą prosto na produkcję.
