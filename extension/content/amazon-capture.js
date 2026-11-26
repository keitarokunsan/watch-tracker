/**
 * Content script for Amazon.co.jp and PrimeVideo.com.
 * Responds to explicit capture requests from the extension dashboard to extract
 * rendered cards (leaving-soon titles OR watchlist titles) from the live DOM.
 */
(() => {
  "use strict";

  const NOISE_TITLES = /^(再生|詳細|ウォッチリスト|削除|Prime|プライム|すべて見る|Amazon|ホーム|映画|テレビ番組|もっと見る|次へ|前へ)$/i;

  function extractAsin(url) {
    if (!url) return "";
    const m = String(url).match(/\/(?:gp\/video\/detail|detail|dp)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    return m ? m[1].toUpperCase() : "";
  }

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function upgradeThumb(src) {
    if (!src || !src.startsWith("http")) return "";
    return src.replace(/_AC_U[XYLR]\d+_/i, "_AC_UL480_");
  }

  /**
   * Capture video cards from the currently rendered Amazon / Prime Video DOM.
   * Uses requestAnimationFrame chunking so large pages (~200 cards) never block input.
   */
  async function captureCardsFromDom() {
    const origin = window.location.origin;
    const candidates = Array.from(
      document.querySelectorAll(
        '[data-component-type="s-search-result"][data-asin], article, [data-testid*="card"], [data-automation-id*="card"]'
      )
    );

    const results = [];
    const seen = new Set();
    const BATCH = 25;

    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          for (const el of slice) {
            const linkEl =
              el.querySelector('a[href*="/gp/video/detail/"], a[href*="/detail/"], a[href*="/dp/"]') ||
              (el.tagName === "A" ? el : null);
            const href = linkEl ? linkEl.href : "";
            const asin = (el.getAttribute("data-asin") || extractAsin(href) || "").toUpperCase();
            if (!asin && !href) continue;

            const titleEl =
              el.querySelector('h2, h3, [data-automation-id="title"], [data-testid*="title"]') ||
              linkEl;
            const imgEl = el.querySelector("img[src]");
            const title = cleanText(
              (titleEl && (titleEl.getAttribute("aria-label") || titleEl.textContent)) ||
                (imgEl && imgEl.alt) ||
                ""
            );
            if (!title || title.length < 2 || title.length > 160 || NOISE_TITLES.test(title)) {
              continue;
            }

            const key = asin || title.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const posterUrl = upgradeThumb(imgEl ? imgEl.currentSrc || imgEl.src : "");
            const cardText = cleanText(el.innerText || el.textContent || "");

            results.push({
              id: asin || `dom-${seen.size}`,
              asin,
              displayTitle: title,
              title,
              posterUrl,
              primeLink: asin ? `${origin}/gp/video/detail/${asin}` : href,
              cardText: cardText.slice(0, 400),
            });
          }
          resolve();
        });
      });
    }

    // Fallback: scan direct video links if generic card containers weren't present
    if (!results.length) {
      const links = Array.from(
        document.querySelectorAll('a[href*="/gp/video/detail/"], a[href*="/detail/"], a[href*="/dp/"]')
      );
      for (const a of links) {
        const asin = extractAsin(a.href);
        const img = a.querySelector("img[src]");
        const title = cleanText(a.getAttribute("aria-label") || (img && img.alt) || a.textContent);
        if (!title || title.length < 2 || title.length > 160 || NOISE_TITLES.test(title)) continue;
        const key = asin || title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          id: asin || `link-${seen.size}`,
          asin,
          displayTitle: title,
          title,
          posterUrl: upgradeThumb(img ? img.currentSrc || img.src : ""),
          primeLink: asin ? `${origin}/gp/video/detail/${asin}` : a.href,
          cardText: title,
        });
      }
    }

    return {
      pageUrl: window.location.href,
      pageTitle: document.title,
      items: results,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "CAPTURE_AMAZON_DOM") {
      return false;
    }
    (async () => {
      try {
        const payload = await captureCardsFromDom();
        sendResponse({ ok: true, ...payload });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
})();
