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
4. `mmw-klub-newsletter` — form zapisu + checkbox zgody + grafika rabatowa.
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
  `mmw-process`, `mmw-team`, `mmw-promo-tiles`, `mmw-map`, `mmw-brands`.
- NIE kasować starych sekcji (`mmw-philosophy`, `mmw-stories`, `mmw-video-product`,
  `mmw-how-its-made`, `mmw-instagram`, `mmw-featured-collection`) — sprzątanie to osobne
  zadanie na koniec, po akceptacji nowej strony głównej.
- Eventy/wydarzenia — poza zakresem, wrócą przy stronie wydarzeń.
- WYJĄTEK: `mmw-related-posts` była na tej liście, ale została świadomie ruszona przy
  konsolidacji karty posta bloga (`snippets/mmw-post-card.liquid`, patrz sekcja niżej) —
  zamiana własnego inline markupu karty na wspólny snippet, reszta sekcji (nagłówek,
  layout listy, przycisk) bez zmian.

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
