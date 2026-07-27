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
Przebudowa:
- `mmw-hero` — obsługa wideo LUB obrazu (media picker), nowy layout.
- `mmw-footer` — nowy design.
- `marquee` — pasek logotypów prasowych (bloki z obrazami, przewijanie).
- UWAGA `mmw-blog-stories`: używa jej też `templates/blog.json` — nie zmieniać jej
  destrukcyjnie; „Opowieści” na głównej robi nowa `mmw-blog-carousel`.

## Czego NIE ruszać w tym sprincie
- Sekcje podstron: `mmw-article-*`, `mmw-blog-hero/posts/tags`, `mmw-related-posts`,
  `mmw-firms-*`, `mmw-collection-*`, `mmw-history-*`, `mmw-chronicle`, `mmw-heritage-note`,
  `mmw-process`, `mmw-team`, `mmw-promo-tiles`, `mmw-map`, `mmw-brands`.
- NIE kasować starych sekcji (`mmw-philosophy`, `mmw-stories`, `mmw-video-product`,
  `mmw-how-its-made`, `mmw-instagram`, `mmw-featured-collection`) — sprzątanie to osobne
  zadanie na koniec, po akceptacji nowej strony głównej.
- Eventy/wydarzenia — poza zakresem, wrócą przy stronie wydarzeń.

## Workflow
- Commit po każdej ukończonej sekcji, komunikaty po polsku, np. `feat: mmw-stats — liczby Majątku`.
- `templates/index.json` przepinać na nowe sekcje dopiero, gdy sekcja jest gotowa i sprawdzona
  na 127.0.0.1:9292 (desktop + mobile 375px).
- Push wyłącznie na theme dev/unpublished; publikacja na live tylko na wyraźne polecenie Oli.
- Dane katalogowe (produkty, metapola, kolekcje) NIE mają stagingu — zmiany w adminie są
  natychmiast live. Definicje metapól i tagi można dodawać bezpiecznie; niczego nie nadpisywać
  ani nie usuwać bez potwierdzenia.
