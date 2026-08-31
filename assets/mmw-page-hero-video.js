// mmw-page-hero — leniwe wideo w tle. Patrz sections/mmw-page-hero.liquid
// (komentarz na górze pliku) i CLAUDE.md, sekcja "mmw-page-hero — leniwe
// wideo w tle" po pełne uzasadnienie decyzji.
//
// <video> NIE istnieje w HTML-u wyrenderowanym przez Liquid — ten skrypt go
// tworzy, dopiero po tym jak strona jest bezczynna (requestIdleCallback,
// zapasowo window.load w przeglądarkach bez wsparcia, np. Safari). Dzięki
// temu: brak JS = zero elementu <video> = zero szans na pobranie, bez
// dodatkowej logiki chowania czegokolwiek.

const DESKTOP_QUERY = '(min-width: 750px)';

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isSaveData() {
  return Boolean(navigator.connection && navigator.connection.saveData);
}

function scheduleWhenIdle(fn) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fn, { timeout: 4000 });
  } else {
    window.addEventListener('load', fn, { once: true });
  }
}

function initHero(configEl) {
  const section = configEl.closest('.mmw-page-hero');
  if (!section) return;

  let config;
  try {
    config = JSON.parse(configEl.textContent);
  } catch (err) {
    return;
  }

  if (prefersReducedMotion() || isSaveData()) return;

  const isDesktop = window.matchMedia(DESKTOP_QUERY).matches;
  if (!isDesktop && !config.showVideoMobile) return;

  const mobileHasOwnVideo = Array.isArray(config.mobileVideo) && config.mobileVideo.length > 0;
  const sources = isDesktop ? config.desktopVideo : mobileHasOwnVideo ? config.mobileVideo : config.desktopVideo;
  if (!Array.isArray(sources) || sources.length === 0) return;

  scheduleWhenIdle(() => {
    const video = document.createElement('video');
    video.className = 'mmw-page-hero__bg-video';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');

    for (const source of sources) {
      const sourceEl = document.createElement('source');
      sourceEl.src = source.url;
      sourceEl.type = source.mime_type;
      video.appendChild(sourceEl);
    }

    // "playing" gwarantuje, że odtwarzanie realnie ruszyło — dopiero wtedy
    // podmieniamy plakat na wideo (CSS crossfade, klasa niżej).
    video.addEventListener(
      'playing',
      () => {
        section.classList.add('mmw-page-hero--video-ready');
      },
      { once: true }
    );

    section.appendChild(video);
    video.load();
    video.play().catch(() => {
      // Autoplay zablokowane mimo muted+playsinline (rzadkie) — plakat
      // zostaje, bez błędu w konsoli.
    });
  });
}

document.querySelectorAll('[data-hero-video-config]').forEach(initHero);
