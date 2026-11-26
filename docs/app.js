(() => {
  "use strict";

  const DATA_URL = "data/expiring.json";
  const LOCAL_WATCHLIST_KEY = "prime_expiring_local_watchlist_v1";
  const COLOR_SCHEME_KEY = "color-scheme";
  const DEFAULT_AMAZON_LEAVING_URL = "https://www.amazon.co.jp/s?rh=n%3A4217521051";

  // 1-click bookmarklet to copy visible titles from Amazon Prime Video Watchlist page
  const WATCHLIST_BOOKMARKLET =
    "javascript:(()=>{const seen=new Set(),out=[];" +
    "const push=t=>{const s=(t||'').replace(/\\s+/g,' ').trim();" +
    "if(!s||s.length<2||s.length>140)return;" +
    "if(/^(再生|詳細|ウォッチリスト|削除|Prime|プライム|すべて見る)$/i.test(s))return;" +
    "const k=s.toLowerCase();if(!seen.has(k)){seen.add(k);out.push(s);}};" +
    "document.querySelectorAll('article,[data-testid*=\"card\"],[data-automation-id*=\"card\"]').forEach(el=>{" +
    "const h=el.querySelector('h2,h3,[data-automation-id=\"title\"],a[aria-label]');" +
    "if(h)push(h.getAttribute('aria-label')||h.textContent);" +
    "else{const img=el.querySelector('img[alt]');if(img)push(img.alt);}});" +
    "if(!out.length){document.querySelectorAll('a[href*=\"/detail/\"],a[href*=\"/dp/\"]').forEach(a=>{" +
    "const img=a.querySelector('img[alt]');push(a.getAttribute('aria-label')||(img&&img.alt)||a.textContent);});}" +
    "if(!out.length){alert('作品名を取得できませんでした。Prime Videoのウォッチリスト画面を下にスクロールしてから再実行してください。');return;}" +
    "const text=out.join('\\n');" +
    "if(navigator.clipboard&&navigator.clipboard.writeText){" +
    "navigator.clipboard.writeText(text).then(()=>alert(out.length+'件の作品名をコピーしました！トラッカー画面に貼り付けてください。'))" +
    ".catch(()=>prompt(out.length+'件を取得しました（Ctrl+Cでコピー）:',text));" +
    "}else{prompt(out.length+'件を取得しました（Ctrl+Cでコピー）:',text);}})();";

  const state = {
    data: null,
    items: [],
    cardMap: new Map(), // id -> HTMLElement
    localWatchlist: [],
    filter: "all",
    sort: "expiry-asc",
    query: "",
    amazonLeavingUrl: DEFAULT_AMAZON_LEAVING_URL,
  };

  // DOM references
  const els = {
    amazonLeavingLink: document.getElementById("amazonLeavingLink"),
    demoBanner: document.getElementById("demoBanner"),
    errorBanner: document.getElementById("errorBanner"),
    statTotal: document.getElementById("statTotal"),
    statUrgent: document.getElementById("statUrgent"),
    statWatchlist: document.getElementById("statWatchlist"),
    statUpdated: document.getElementById("statUpdated"),
    searchInput: document.getElementById("searchInput"),
    filterButtons: Array.from(document.querySelectorAll("[data-filter]")),
    sortSelect: document.getElementById("sortSelect"),
    visibleCountText: document.getElementById("visibleCountText"),
    gridStatus: document.getElementById("gridStatus"),
    cardGrid: document.getElementById("cardGrid"),
    emptyState: document.getElementById("emptyState"),
    emptyStateText: document.getElementById("emptyStateText"),
    resetFiltersBtn: document.getElementById("resetFiltersBtn"),
    tmdbAttribution: document.getElementById("tmdbAttribution"),
    openSettingsBtn: document.getElementById("openSettingsBtn"),
    settingsDialog: document.getElementById("settingsDialog"),
    watchlistTextarea: document.getElementById("watchlistTextarea"),
    saveWatchlistBtn: document.getElementById("saveWatchlistBtn"),
    copyWatchlistTxtBtn: document.getElementById("copyWatchlistTxtBtn"),
    watchlistSaveFeedback: document.getElementById("watchlistSaveFeedback"),
    bookmarkletLink: document.getElementById("bookmarkletLink"),
    copyBookmarkletBtn: document.getElementById("copyBookmarkletBtn"),
    bookmarkletFeedback: document.getElementById("bookmarkletFeedback"),
    themeRadios: Array.from(document.querySelectorAll('input[name="themeScheme"]')),
    systemThemeLabel: document.getElementById("systemThemeLabel"),
    detailDialog: document.getElementById("detailDialog"),
    detailDialogTitle: document.getElementById("detailDialogTitle"),
    detailDialogBody: document.getElementById("detailDialogBody"),
    detailPrimeBtn: document.getElementById("detailPrimeBtn"),
    detailLeavingListBtn: document.getElementById("detailLeavingListBtn"),
  };

  /* ------------------------------------------------------------------------
   * Normalization & Watchlist matching (mirrors scripts/watchlist.py)
   * --------------------------------------------------------------------- */
  const STRIP_RE =
    /[\s\u3000\-‐‑‒–—―~〜～:：;；!！?？.,。、・･'’"“”()（）\[\]【】「」『』/／\\|_]+/g;
  const SUFFIX_RE =
    /(?:\s*(?:シーズン|season|part|パート|第)\s*\d+.*|\s*\((?:字幕版|吹替版|吹き替え版|日本語吹替版|4k|uhd|hd)\)|\s*（(?:字幕版|吹替版|吹き替え版|日本語吹替版|4k|uhd|hd)）)$/i;

  function normalizeTitle(text) {
    if (!text) return "";
    return String(text)
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(SUFFIX_RE, "")
      .trim()
      .replace(STRIP_RE, "");
  }

  function loadLocalWatchlist() {
    try {
      const raw = localStorage.getItem(LOCAL_WATCHLIST_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.trim()) : [];
    } catch (_) {
      return [];
    }
  }

  function saveLocalWatchlist(entries) {
    const cleaned = [];
    const seen = new Set();
    for (const line of entries) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const norm = normalizeTitle(trimmed);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        cleaned.push(trimmed);
      }
    }
    state.localWatchlist = cleaned;
    try {
      localStorage.setItem(LOCAL_WATCHLIST_KEY, JSON.stringify(cleaned));
    } catch (_) {}
    return cleaned;
  }

  function isLocalWatchlistMatch(item) {
    if (!state.localWatchlist.length) return false;
    const candidates = [item.displayTitle, item.titleJa, item.title, item.originalTitle]
      .map(normalizeTitle)
      .filter(Boolean);
    for (const entry of state.localWatchlist) {
      const normEntry = normalizeTitle(entry);
      if (!normEntry) continue;
      for (const cand of candidates) {
        if (normEntry === cand) return true;
        if (normEntry.length >= 3 && (cand.includes(normEntry) || normEntry.includes(cand))) {
          return true;
        }
      }
    }
    return false;
  }

  function isEffectiveWatchlist(item) {
    return Boolean(item.inWatchlist) || isLocalWatchlistMatch(item);
  }

  /* ------------------------------------------------------------------------
   * Poster SVG fallback (prevents broken images if CDN fails)
   * --------------------------------------------------------------------- */
  function createFallbackPosterUri(title, showType) {
    const label = showType === "series" ? "SERIES" : "MOVIE";
    const safeTitle = String(title || "No Title")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const chunks = [];
    for (let i = 0; i < Math.min(safeTitle.length, 30); i += 10) {
      chunks.push(safeTitle.slice(i, i + 10));
    }
    const tspans = chunks
      .map((line, i) => `<tspan x="20" dy="${i === 0 ? 0 : 26}">${line}</tspan>`)
      .join("");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 360" width="240" height="360">` +
      `<rect width="240" height="360" fill="#172336"/>` +
      `<rect x="18" y="20" width="70" height="22" rx="11" fill="#00a8e1"/>` +
      `<text x="53" y="35" fill="#031522" font-family="sans-serif" font-size="11" font-weight="800" text-anchor="middle">${label}</text>` +
      `<text x="20" y="190" fill="#f8fafc" font-family="sans-serif" font-size="19" font-weight="700">${tspans}</text>` +
      `</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  /* ------------------------------------------------------------------------
   * Color scheme (follows dark-mode & dark-mode-toggle guidelines)
   * --------------------------------------------------------------------- */
  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

  function getStoredTheme() {
    try {
      const val = localStorage.getItem(COLOR_SCHEME_KEY);
      return val === "light" || val === "dark" ? val : "system";
    } catch (_) {
      return "system";
    }
  }

  function applyColorScheme(mode, persist = true) {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (mode === "light" || mode === "dark") {
      if (meta) meta.content = mode;
      if (persist) {
        try {
          localStorage.setItem(COLOR_SCHEME_KEY, mode);
        } catch (_) {}
      }
    } else {
      if (meta) meta.content = "light dark";
      if (persist) {
        try {
          localStorage.removeItem(COLOR_SCHEME_KEY);
        } catch (_) {}
      }
    }
    for (const radio of els.themeRadios) {
      radio.checked = radio.value === (mode === "light" || mode === "dark" ? mode : "system");
    }
  }

  function updateSystemThemeLabel() {
    const current = darkMedia.matches ? "ダーク" : "ライト";
    els.systemThemeLabel.textContent = `システム設定に従う（現在: ${current}）`;
  }

  function initColorScheme() {
    updateSystemThemeLabel();
    applyColorScheme(getStoredTheme(), false);

    darkMedia.addEventListener("change", () => {
      updateSystemThemeLabel();
      // Do NOT clear stored user override when system scheme changes
    });

    for (const radio of els.themeRadios) {
      radio.addEventListener("change", () => {
        if (radio.checked) applyColorScheme(radio.value, true);
      });
    }

    window.addEventListener("storage", (event) => {
      if (event.key === COLOR_SCHEME_KEY) {
        applyColorScheme(getStoredTheme(), false);
      }
    });
  }

  /* ------------------------------------------------------------------------
   * Dialog light-dismiss fallback (Safari doesn't yet support closedby="any")
   * --------------------------------------------------------------------- */
  function attachLightDismissFallback(dialog) {
    if ("closedBy" in HTMLDialogElement.prototype) return;
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) {
        dialog.close();
      }
    });
  }

  /* ------------------------------------------------------------------------
   * Dynamic sorting without recreating DOM nodes (dynamic-sort guide)
   * --------------------------------------------------------------------- */
  function reorderNodes(container, orderedNodes) {
    const move = Object.hasOwn(Element.prototype, "moveBefore")
      ? (node) => container.moveBefore(node, null)
      : (node) => container.append(node);
    for (const node of orderedNodes) {
      move(node);
    }
  }

  function applyDomOrder(orderedNodes, visibleIds, shouldAnimate) {
    const update = () => {
      for (const [id, card] of state.cardMap.entries()) {
        card.hidden = !visibleIds.has(id);
      }
      reorderNodes(els.cardGrid, orderedNodes);
    };

    if (shouldAnimate && visibleIds.size <= 150) {
      if (typeof els.cardGrid.startViewTransition === "function") {
        els.cardGrid.startViewTransition(update);
        return;
      }
      if (typeof document.startViewTransition === "function") {
        document.startViewTransition(update);
        return;
      }
    }
    update();
  }

  /* ------------------------------------------------------------------------
   * Card creation (created once per dataset, updated in place)
   * --------------------------------------------------------------------- */
  function daysBadgeMeta(item) {
    const d = item.daysLeft;
    if (d === null || d === undefined) {
      return { text: "期限未確定", cls: "days-badge--unknown" };
    }
    if (d <= 0) {
      return { text: "本日終了", cls: "days-badge--critical" };
    }
    if (d <= 3) {
      return { text: `あと${d}日`, cls: "days-badge--critical" };
    }
    if (d <= 7) {
      return { text: `あと${d}日`, cls: "days-badge--soon" };
    }
    return { text: `あと${d}日`, cls: "" };
  }

  function createCardElement(item, index) {
    const card = document.createElement("article");
    card.className = "movie-card";
    // Apply content-visibility: auto ONLY strictly below the initial fold
    if (index >= 8) {
      card.classList.add("card--deferred");
    }
    card.dataset.id = item.id;

    const primeHref = item.primeLink || state.amazonLeavingUrl;
    const badge = daysBadgeMeta(item);

    // Poster link
    const posterLink = document.createElement("a");
    posterLink.className = "poster-link";
    posterLink.href = primeHref;
    posterLink.target = "_blank";
    posterLink.rel = "noopener noreferrer";
    posterLink.setAttribute("aria-label", `${item.displayTitle} を Prime Video で開く`);

    const img = document.createElement("img");
    img.className = "poster-img";
    img.width = 240;
    img.height = 360;
    img.alt = `${item.displayTitle} のポスター`;
    const fallbackUri = createFallbackPosterUri(item.displayTitle, item.showType);
    img.src = item.posterUrl || fallbackUri;
    img.addEventListener(
      "error",
      () => {
        if (img.src !== fallbackUri) img.src = fallbackUri;
      },
      { once: true }
    );

    // Optimize image priority (optimize-image-priority guide):
    // - Top 2 LCP candidates: fetchpriority="high", NO loading="lazy"
    // - Indices 2..5: default priority (omit both)
    // - Below the fold (6+): loading="lazy" ALONE (never combine with fetchpriority="low")
    if (index < 2) {
      img.setAttribute("fetchpriority", "high");
    } else if (index >= 6) {
      img.loading = "lazy";
      img.decoding = "async";
    }

    const badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";

    const daysBadge = document.createElement("span");
    daysBadge.className = `days-badge ${badge.cls}`.trim();
    daysBadge.textContent = badge.text;
    badgeRow.append(daysBadge);

    const wlPill = document.createElement("span");
    wlPill.className = "watchlist-pill";
    wlPill.textContent = "★ ウォッチリスト";
    wlPill.hidden = true;
    badgeRow.append(wlPill);

    const typeOverlay = document.createElement("span");
    typeOverlay.className = "type-overlay";
    typeOverlay.textContent = item.showType === "series" ? "ドラマ・アニメ" : "映画";

    posterLink.append(img, badgeRow, typeOverlay);

    // Body
    const body = document.createElement("div");
    body.className = "card-body";

    const titleHeading = document.createElement("h2");
    titleHeading.className = "card-title";
    const titleAnchor = document.createElement("a");
    titleAnchor.href = primeHref;
    titleAnchor.target = "_blank";
    titleAnchor.rel = "noopener noreferrer";
    titleAnchor.textContent = item.displayTitle;
    titleHeading.append(titleAnchor);
    body.append(titleHeading);

    if (item.title && item.title !== item.displayTitle) {
      const sub = document.createElement("p");
      sub.className = "card-subtitle";
      sub.textContent = item.title;
      body.append(sub);
    }

    const expiryEl = document.createElement("div");
    expiryEl.className = "card-expiry";
    expiryEl.textContent = item.expiresDate
      ? `期限: ${item.expiresDateLabel}`
      : item.expiresDateLabel || "まもなく終了";
    body.append(expiryEl);

    const metaRow = document.createElement("div");
    metaRow.className = "card-meta";
    const metaParts = [];
    if (item.releaseYear) metaParts.push(`${item.releaseYear}年`);
    if (item.rating) metaParts.push(`★ ${item.rating}%`);
    if (item.showType === "series" && item.seasonCount) {
      metaParts.push(`全${item.seasonCount}シーズン`);
    } else if (item.runtime) {
      metaParts.push(`${item.runtime}分`);
    }
    if (metaParts.length) {
      const infoSpan = document.createElement("span");
      infoSpan.textContent = metaParts.join(" · ");
      metaRow.append(infoSpan);
    }
    for (const genre of (item.genres || []).slice(0, 2)) {
      const tag = document.createElement("span");
      tag.className = "genre-tag";
      tag.textContent = genre;
      metaRow.append(tag);
    }
    body.append(metaRow);

    // Actions
    const actions = document.createElement("div");
    actions.className = "card-actions";

    const cta = document.createElement("a");
    cta.className = "card-cta";
    cta.href = primeHref;
    cta.target = "_blank";
    cta.rel = "noopener noreferrer";
    cta.textContent = "Primeで見る ↗";

    const wlBtn = document.createElement("button");
    wlBtn.type = "button";
    wlBtn.className = "card-mini-btn";
    wlBtn.dataset.role = "wl-toggle";
    wlBtn.addEventListener("click", () => toggleCardLocalWatchlist(item));

    const detailBtn = document.createElement("button");
    detailBtn.type = "button";
    detailBtn.className = "card-mini-btn";
    detailBtn.textContent = "詳細";
    detailBtn.addEventListener("click", () => openDetailModal(item));

    actions.append(cta, wlBtn, detailBtn);
    body.append(actions);

    card.append(posterLink, body);
    syncCardWatchlistState(card, item);
    return card;
  }

  function syncCardWatchlistState(card, item) {
    const matched = isEffectiveWatchlist(item);
    card.classList.toggle("movie-card--watchlist", matched);
    const pill = card.querySelector(".watchlist-pill");
    if (pill) pill.hidden = !matched;

    const btn = card.querySelector('[data-role="wl-toggle"]');
    if (btn) {
      btn.setAttribute("aria-pressed", String(matched));
      btn.textContent = matched ? "★" : "☆";
      btn.title = matched
        ? "ウォッチリスト登録済み（クリックでローカル解除）"
        : "ローカルウォッチリストに追加";
      btn.setAttribute(
        "aria-label",
        matched
          ? `${item.displayTitle} はウォッチリスト登録済み`
          : `${item.displayTitle} をウォッチリストに追加`
      );
    }
  }

  function toggleCardLocalWatchlist(item) {
    const normDisplay = normalizeTitle(item.displayTitle);
    const existsInLocal = state.localWatchlist.some(
      (entry) => normalizeTitle(entry) === normDisplay
    );
    if (existsInLocal) {
      saveLocalWatchlist(
        state.localWatchlist.filter((entry) => normalizeTitle(entry) !== normDisplay)
      );
    } else {
      saveLocalWatchlist([...state.localWatchlist, item.displayTitle]);
    }
    els.watchlistTextarea.value = state.localWatchlist.join("\n");
    refreshWatchlistBadgesAndStats();
    applyFiltersAndSort(false);
  }

  function refreshWatchlistBadgesAndStats() {
    let wlCount = 0;
    for (const item of state.items) {
      if (isEffectiveWatchlist(item)) wlCount += 1;
      const card = state.cardMap.get(item.id);
      if (card) syncCardWatchlistState(card, item);
    }
    els.statWatchlist.textContent = `${wlCount} 件`;
  }

  /* ------------------------------------------------------------------------
   * Detail Modal
   * --------------------------------------------------------------------- */
  function openDetailModal(item) {
    els.detailDialogTitle.textContent = item.displayTitle;
    els.detailPrimeBtn.href = item.primeLink || state.amazonLeavingUrl;
    els.detailLeavingListBtn.href = state.amazonLeavingUrl;

    const body = els.detailDialogBody;
    body.replaceChildren();

    const layout = document.createElement("div");
    layout.className = "detail-layout";

    const img = document.createElement("img");
    img.className = "detail-poster";
    img.width = 240;
    img.height = 360;
    img.alt = `${item.displayTitle} のポスター`;
    const fallbackUri = createFallbackPosterUri(item.displayTitle, item.showType);
    img.src = item.posterUrl || fallbackUri;
    img.addEventListener("error", () => {
      if (img.src !== fallbackUri) img.src = fallbackUri;
    });

    const info = document.createElement("div");
    const list = document.createElement("ul");
    list.className = "detail-meta-list";

    const badge = daysBadgeMeta(item);
    const rows = [
      ["配信期限", `${item.expiresDateLabel || "期限未確定"}（${badge.text}）`],
      ["種別", item.showType === "series" ? "ドラマ・アニメ" : "映画"],
      item.title && item.title !== item.displayTitle ? ["英題 / 原題", item.title] : null,
      item.releaseYear ? ["公開・放送年", `${item.releaseYear}年`] : null,
      item.rating ? ["評価スコア", `${item.rating}%`] : null,
      item.genres && item.genres.length ? ["ジャンル", item.genres.join(" / ")] : null,
      isEffectiveWatchlist(item) ? ["ウォッチリスト", "★ 一致しています"] : null,
    ].filter(Boolean);

    for (const [k, v] of rows) {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = `${k}: `;
      li.append(strong, document.createTextNode(v));
      list.append(li);
    }
    info.append(list);

    const overview = document.createElement("p");
    overview.className = "detail-overview";
    overview.textContent = item.displayOverview || "あらすじ情報はありません。";
    info.append(overview);

    layout.append(img, info);
    body.append(layout);

    els.detailDialog.showModal();
  }

  /* ------------------------------------------------------------------------
   * Filtering & Sorting
   * --------------------------------------------------------------------- */
  function matchesFilter(item) {
    if (state.filter === "watchlist" && !isEffectiveWatchlist(item)) return false;
    if (state.filter === "urgent" && (item.daysLeft === null || item.daysLeft > 7)) return false;
    if (state.filter === "movie" && item.showType !== "movie") return false;
    if (state.filter === "series" && item.showType !== "series") return false;

    if (state.query) {
      const q = state.query.normalize("NFKC").toLowerCase();
      const haystack = [
        item.displayTitle,
        item.title,
        item.originalTitle,
        ...(item.genres || []),
      ]
        .join(" ")
        .normalize("NFKC")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function compareItems(a, b) {
    const expA = a.expiresOn ?? Number.MAX_SAFE_INTEGER;
    const expB = b.expiresOn ?? Number.MAX_SAFE_INTEGER;

    switch (state.sort) {
      case "expiry-desc": {
        const dA = a.expiresOn ?? -1;
        const dB = b.expiresOn ?? -1;
        if (dA !== dB) return dB - dA;
        return a.displayTitle.localeCompare(b.displayTitle, "ja");
      }
      case "watchlist-first": {
        const wA = isEffectiveWatchlist(a) ? 0 : 1;
        const wB = isEffectiveWatchlist(b) ? 0 : 1;
        if (wA !== wB) return wA - wB;
        if (expA !== expB) return expA - expB;
        return a.displayTitle.localeCompare(b.displayTitle, "ja");
      }
      case "rating-desc": {
        const rA = a.rating ?? -1;
        const rB = b.rating ?? -1;
        if (rA !== rB) return rB - rA;
        return expA - expB;
      }
      case "title-asc":
        return a.displayTitle.localeCompare(b.displayTitle, "ja");
      case "expiry-asc":
      default:
        if (expA !== expB) return expA - expB;
        return (b.rating ?? 0) - (a.rating ?? 0);
    }
  }

  function applyFiltersAndSort(animate = true) {
    const sorted = [...state.items].sort(compareItems);
    const visibleIds = new Set();
    const orderedNodes = [];

    for (const item of sorted) {
      const node = state.cardMap.get(item.id);
      if (!node) continue;
      if (matchesFilter(item)) {
        visibleIds.add(item.id);
      }
      orderedNodes.push(node);
    }

    applyDomOrder(orderedNodes, visibleIds, animate);

    const visibleCount = visibleIds.size;
    els.visibleCountText.textContent = `表示中: ${visibleCount} 件 / 全 ${state.items.length} 件`;

    const sortText = els.sortSelect.options[els.sortSelect.selectedIndex]?.textContent || "";
    els.gridStatus.textContent = `${sortText}、${visibleCount}件を表示しています`;

    const isEmpty = visibleCount === 0;
    els.emptyState.hidden = !isEmpty;
    if (isEmpty && state.filter === "watchlist") {
      els.emptyStateText.textContent =
        "現在、ウォッチリストに一致する配信終了予定作品はありません。右上の「★ ウォッチリスト・設定」から作品名を追加できます。";
    } else if (isEmpty) {
      els.emptyStateText.textContent = "条件に一致する作品はありませんでした。";
    }
  }

  /* ------------------------------------------------------------------------
   * Settings Dialog & Bookmarklet
   * --------------------------------------------------------------------- */
  function initSettingsDialog() {
    els.bookmarkletLink.href = WATCHLIST_BOOKMARKLET;
    els.bookmarkletLink.addEventListener("click", (event) => {
      event.preventDefault();
      els.bookmarkletFeedback.textContent =
        "このボタンをブラウザのブックマークバーへドラッグして保存してください。";
    });

    els.copyBookmarkletBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(WATCHLIST_BOOKMARKLET);
        els.bookmarkletFeedback.textContent = "ブックマークレットのコードをコピーしました。";
      } catch (_) {
        els.bookmarkletFeedback.textContent = "コピーに失敗しました。手動でリンクURLをコピーしてください。";
      }
    });

    els.openSettingsBtn.addEventListener("click", () => {
      els.watchlistTextarea.value = state.localWatchlist.join("\n");
      els.watchlistSaveFeedback.textContent = "";
      els.bookmarkletFeedback.textContent = "";
      els.settingsDialog.showModal();
    });

    els.saveWatchlistBtn.addEventListener("click", () => {
      const lines = els.watchlistTextarea.value.split(/\r?\n/);
      const saved = saveLocalWatchlist(lines);
      els.watchlistTextarea.value = saved.join("\n");
      refreshWatchlistBadgesAndStats();
      applyFiltersAndSort(false);
      els.watchlistSaveFeedback.textContent = `${saved.length}件を保存して反映しました。`;
    });

    els.copyWatchlistTxtBtn.addEventListener("click", async () => {
      const lines = els.watchlistTextarea.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"));
      const content =
        "# config/watchlist.txt に貼り付けてGitHubへ保存すると自動通知にも反映されます\n" +
        lines.join("\n") +
        "\n";
      try {
        await navigator.clipboard.writeText(content);
        els.watchlistSaveFeedback.textContent =
          "config/watchlist.txt 形式でクリップボードにコピーしました。";
      } catch (_) {
        els.watchlistSaveFeedback.textContent = "クリップボードへのコピーに失敗しました。";
      }
    });
  }

  /* ------------------------------------------------------------------------
   * Event wiring & Data Boot
   * --------------------------------------------------------------------- */
  function initControls() {
    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value.trim();
      applyFiltersAndSort(false);
    });

    for (const btn of els.filterButtons) {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter || "all";
        for (const other of els.filterButtons) {
          other.setAttribute("aria-pressed", String(other === btn));
        }
        applyFiltersAndSort(true);
      });
    }

    els.sortSelect.addEventListener("change", () => {
      state.sort = els.sortSelect.value;
      applyFiltersAndSort(true);
    });

    els.resetFiltersBtn.addEventListener("click", () => {
      state.filter = "all";
      state.query = "";
      els.searchInput.value = "";
      for (const btn of els.filterButtons) {
        btn.setAttribute("aria-pressed", String(btn.dataset.filter === "all"));
      }
      applyFiltersAndSort(false);
    });
  }

  async function boot() {
    initColorScheme();
    attachLightDismissFallback(els.settingsDialog);
    attachLightDismissFallback(els.detailDialog);
    state.localWatchlist = loadLocalWatchlist();
    initSettingsDialog();
    initControls();

    try {
      const resp = await fetch(`${DATA_URL}?t=${Math.floor(Date.now() / 60000)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      state.data = data;
      state.items = Array.isArray(data.items) ? data.items : [];
      state.amazonLeavingUrl = data.amazonLeavingSoonUrl || DEFAULT_AMAZON_LEAVING_URL;

      els.amazonLeavingLink.href = state.amazonLeavingUrl;
      els.demoBanner.hidden = !data.isDemo;
      els.tmdbAttribution.hidden = !data.tmdbEnabled;

      els.statTotal.textContent = `${state.items.length} 件`;
      const urgentCount = state.items.filter(
        (it) => it.daysLeft !== null && it.daysLeft !== undefined && it.daysLeft <= 7
      ).length;
      els.statUrgent.textContent = `${urgentCount} 件`;
      els.statUpdated.textContent = data.updatedAtLabel || "-";

      const fragment = document.createDocumentFragment();
      state.cardMap.clear();
      state.items.forEach((item, idx) => {
        const card = createCardElement(item, idx);
        state.cardMap.set(item.id, card);
        fragment.append(card);
      });
      els.cardGrid.replaceChildren(fragment);

      refreshWatchlistBadgesAndStats();
      applyFiltersAndSort(false);
    } catch (err) {
      els.errorBanner.hidden = false;
      els.errorBanner.textContent =
        `データの読み込みに失敗しました (${err.message})。ローカルで確認する場合は ` +
        `python -m http.server 8000 --directory docs で起動してください。`;
      els.visibleCountText.textContent = "読み込みエラー";
    }
  }

  boot();
})();
