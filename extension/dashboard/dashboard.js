import {
  AMAZON_LEAVING_SOON_URL,
  AMAZON_WATCHLIST_URL,
  matchWatchlist,
  normalizeTitle,
  parseDetailPageHtml,
  parseExpiryText,
  parseSearchPageHtml,
  parseWatchlistHtml,
} from "../lib/amazon-parser.js";

const STORAGE_KEYS = {
  ITEMS: "expiringItems",
  META: "scanMeta",
  WATCHLIST: "watchlistEntries",
  SETTINGS: "userSettings",
};

const COLOR_SCHEME_KEY = "color-scheme";
const DETAIL_CACHE_MS = 12 * 60 * 60 * 1000; // 12h per-ASIN detail cache
const SEARCH_DELAY_MS = 450;
const DETAIL_BATCH_SIZE = 3;
const DETAIL_BATCH_DELAY_MS = 350;

const state = {
  items: [],
  cardMap: new Map(),
  watchlist: [],
  settings: {
    autoScanEnabled: false,
    autoScanIntervalHours: 12,
    desktopNotifyEnabled: true,
    discordWebhookUrl: "",
  },
  meta: null,
  filter: "all",
  sort: "expiry-asc",
  query: "",
  scanning: false,
  abortController: null,
};

const els = {
  scanFullBtn: document.getElementById("scanFullBtn"),
  emptyScanBtn: document.getElementById("emptyScanBtn"),
  captureTabBtn: document.getElementById("captureTabBtn"),
  openSettingsBtn: document.getElementById("openSettingsBtn"),
  progressPanel: document.getElementById("progressPanel"),
  progressTitle: document.getElementById("progressTitle"),
  progressBar: document.getElementById("progressBar"),
  progressDetail: document.getElementById("progressDetail"),
  cancelScanBtn: document.getElementById("cancelScanBtn"),
  noticeBanner: document.getElementById("noticeBanner"),
  statTotal: document.getElementById("statTotal"),
  statUrgent: document.getElementById("statUrgent"),
  statTwoWeeks: document.getElementById("statTwoWeeks"),
  statWatchlist: document.getElementById("statWatchlist"),
  statUpdated: document.getElementById("statUpdated"),
  searchInput: document.getElementById("searchInput"),
  filterButtons: Array.from(document.querySelectorAll("[data-filter]")),
  sortSelect: document.getElementById("sortSelect"),
  visibleCountText: document.getElementById("visibleCountText"),
  checkDetailsOnlyBtn: document.getElementById("checkDetailsOnlyBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  gridStatus: document.getElementById("gridStatus"),
  cardGrid: document.getElementById("cardGrid"),
  emptyState: document.getElementById("emptyState"),
  emptyStateText: document.getElementById("emptyStateText"),
  resetFiltersBtn: document.getElementById("resetFiltersBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  syncWatchlistBtn: document.getElementById("syncWatchlistBtn"),
  watchlistTextarea: document.getElementById("watchlistTextarea"),
  saveWatchlistBtn: document.getElementById("saveWatchlistBtn"),
  watchlistFeedback: document.getElementById("watchlistFeedback"),
  autoScanCheckbox: document.getElementById("autoScanCheckbox"),
  autoScanIntervalSelect: document.getElementById("autoScanIntervalSelect"),
  desktopNotifyCheckbox: document.getElementById("desktopNotifyCheckbox"),
  discordWebhookInput: document.getElementById("discordWebhookInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  testDiscordBtn: document.getElementById("testDiscordBtn"),
  settingsFeedback: document.getElementById("settingsFeedback"),
  themeRadios: Array.from(document.querySelectorAll('input[name="themeScheme"]')),
  systemThemeLabel: document.getElementById("systemThemeLabel"),
  detailDialog: document.getElementById("detailDialog"),
  detailDialogTitle: document.getElementById("detailDialogTitle"),
  detailDialogBody: document.getElementById("detailDialogBody"),
  detailPrimeBtn: document.getElementById("detailPrimeBtn"),
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    }
  });
}

function showNotice(text, kind = "info") {
  if (!text) {
    els.noticeBanner.hidden = true;
    els.noticeBanner.textContent = "";
    return;
  }
  els.noticeBanner.hidden = false;
  els.noticeBanner.className = `banner banner-${kind}`;
  els.noticeBanner.textContent = text;
}

function setProgress(active, title = "", value = 0, max = 100, detail = "") {
  els.progressPanel.hidden = !active;
  els.scanFullBtn.disabled = active;
  els.emptyScanBtn.disabled = active;
  els.captureTabBtn.disabled = active;
  els.checkDetailsOnlyBtn.disabled = active;
  if (active) {
    els.progressTitle.textContent = title;
    els.progressBar.max = Math.max(1, max);
    els.progressBar.value = Math.min(value, Math.max(1, max));
    els.progressDetail.textContent = detail;
  }
}

function createFallbackPosterUri(title, showType) {
  const label = showType === "series" ? "SERIES" : "MOVIE";
  const safeTitle = String(title || "No Title")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = [];
  for (let i = 0; i < Math.min(safeTitle.length, 30); i += 10) {
    lines.push(safeTitle.slice(i, i + 10));
  }
  const tspans = lines
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

/* --------------------------------------------------------------------------
 * Theme handling (dark-mode & dark-mode-toggle)
 * ----------------------------------------------------------------------- */
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function getStoredTheme() {
  try {
    const v = localStorage.getItem(COLOR_SCHEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
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
  for (const r of els.themeRadios) {
    r.checked = r.value === (mode === "light" || mode === "dark" ? mode : "system");
  }
}

function updateSystemThemeLabel() {
  els.systemThemeLabel.textContent = `システム設定に従う（現在: ${darkMedia.matches ? "ダーク" : "ライト"}）`;
}

function initColorScheme() {
  updateSystemThemeLabel();
  applyColorScheme(getStoredTheme(), false);
  darkMedia.addEventListener("change", () => {
    updateSystemThemeLabel();
  });
  for (const r of els.themeRadios) {
    r.addEventListener("change", () => {
      if (r.checked) applyColorScheme(r.value, true);
    });
  }
  window.addEventListener("storage", (e) => {
    if (e.key === COLOR_SCHEME_KEY) applyColorScheme(getStoredTheme(), false);
  });
}

/* --------------------------------------------------------------------------
 * Dialog light-dismiss fallback (Safari / browsers without closedBy)
 * ----------------------------------------------------------------------- */
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
    if (!inside) dialog.close();
  });
}

/* --------------------------------------------------------------------------
 * Storage helpers
 * ----------------------------------------------------------------------- */
async function persistAll() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.ITEMS]: state.items,
    [STORAGE_KEYS.META]: state.meta,
    [STORAGE_KEYS.WATCHLIST]: state.watchlist,
    [STORAGE_KEYS.SETTINGS]: state.settings,
  });
  try {
    await chrome.runtime.sendMessage({ type: "SYNC_ALARM_AND_BADGE" });
  } catch (_) {}
}

function isWatchlistMatched(item) {
  return Boolean(matchWatchlist([item.displayTitle, item.title], state.watchlist));
}

/* --------------------------------------------------------------------------
 * Dynamic sorting & card rendering (reuses existing DOM nodes)
 * ----------------------------------------------------------------------- */
function reorderNodes(container, orderedNodes) {
  const move = Object.hasOwn(Element.prototype, "moveBefore")
    ? (node) => container.moveBefore(node, null)
    : (node) => container.append(node);
  for (const node of orderedNodes) move(node);
}

function applyDomOrder(orderedNodes, visibleIds, animate) {
  const update = () => {
    for (const [id, card] of state.cardMap.entries()) {
      card.hidden = !visibleIds.has(id);
    }
    reorderNodes(els.cardGrid, orderedNodes);
  };
  if (animate && visibleIds.size <= 150) {
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

function daysBadgeMeta(item) {
  if (item.hoursLeft !== null && item.hoursLeft !== undefined) {
    return { text: `あと${item.hoursLeft}時間`, cls: "days-badge--critical" };
  }
  const d = item.daysLeft;
  if (d === null || d === undefined) {
    return { text: "30日以内", cls: "days-badge--unknown" };
  }
  if (d <= 0) return { text: "本日終了", cls: "days-badge--critical" };
  if (d <= 3) return { text: `あと${d}日`, cls: "days-badge--critical" };
  if (d <= 7) return { text: `あと${d}日`, cls: "days-badge--soon" };
  return { text: `あと${d}日`, cls: "" };
}

function updateCardContents(card, item) {
  const badge = daysBadgeMeta(item);
  const badgeEl = card.querySelector(".days-badge");
  if (badgeEl) {
    badgeEl.className = `days-badge ${badge.cls}`.trim();
    badgeEl.textContent = badge.text;
  }

  const matched = isWatchlistMatched(item);
  card.classList.toggle("movie-card--watchlist", matched);
  const wlPill = card.querySelector(".watchlist-pill");
  if (wlPill) wlPill.hidden = !matched;

  const wlBtn = card.querySelector('[data-role="wl-toggle"]');
  if (wlBtn) {
    wlBtn.setAttribute("aria-pressed", String(matched));
    wlBtn.textContent = matched ? "★" : "☆";
  }

  const expiryEl = card.querySelector(".card-expiry");
  if (expiryEl) {
    expiryEl.textContent = `期限: ${item.expiresDateLabel || "30日以内"}`;
  }

  const rawEl = card.querySelector(".card-expiry-raw");
  if (rawEl) {
    rawEl.textContent = item.rawExpiryText || (item.detailCheckedAt ? "公式詳細を確認済み" : "未確認（詳細チェック待ち）");
  }

  const typeEl = card.querySelector(".type-overlay");
  if (typeEl) {
    typeEl.textContent = item.showType === "series" ? "ドラマ・アニメ" : "映画";
  }
}

function createCardElement(item, index) {
  const card = document.createElement("article");
  card.className = "movie-card";
  if (index >= 8) card.classList.add("card--deferred");
  card.dataset.id = item.id;

  const href = item.primeLink || AMAZON_LEAVING_SOON_URL;

  const posterLink = document.createElement("a");
  posterLink.className = "poster-link";
  posterLink.href = href;
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

  // optimize-image-priority: top 2 high priority, 2..5 default, 6+ lazy alone
  if (index < 2) {
    img.setAttribute("fetchpriority", "high");
  } else if (index >= 6) {
    img.loading = "lazy";
    img.decoding = "async";
  }

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  const daysBadge = document.createElement("span");
  daysBadge.className = "days-badge";
  const wlPill = document.createElement("span");
  wlPill.className = "watchlist-pill";
  wlPill.textContent = "★ ウォッチリスト";
  wlPill.hidden = true;
  badgeRow.append(daysBadge, wlPill);

  const typeOverlay = document.createElement("span");
  typeOverlay.className = "type-overlay";
  posterLink.append(img, badgeRow, typeOverlay);

  const body = document.createElement("div");
  body.className = "card-body";

  const titleHeading = document.createElement("h2");
  titleHeading.className = "card-title";
  const titleAnchor = document.createElement("a");
  titleAnchor.href = href;
  titleAnchor.target = "_blank";
  titleAnchor.rel = "noopener noreferrer";
  titleAnchor.textContent = item.displayTitle;
  titleHeading.append(titleAnchor);

  const expiryEl = document.createElement("div");
  expiryEl.className = "card-expiry";
  const rawEl = document.createElement("div");
  rawEl.className = "card-expiry-raw";

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const cta = document.createElement("a");
  cta.className = "card-cta";
  cta.href = href;
  cta.target = "_blank";
  cta.rel = "noopener noreferrer";
  cta.textContent = "Primeで見る ↗";

  const wlBtn = document.createElement("button");
  wlBtn.type = "button";
  wlBtn.className = "card-mini-btn";
  wlBtn.dataset.role = "wl-toggle";
  wlBtn.title = "ウォッチリストに追加 / 解除";
  wlBtn.addEventListener("click", () => toggleItemWatchlist(item));

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "card-mini-btn";
  detailBtn.textContent = "詳細";
  detailBtn.addEventListener("click", () => openDetailModal(item));

  actions.append(cta, wlBtn, detailBtn);
  body.append(titleHeading, expiryEl, rawEl, actions);
  card.append(posterLink, body);
  updateCardContents(card, item);
  return card;
}

function rebuildCardsIfNeeded() {
  const existingIds = new Set(state.cardMap.keys());
  const nextIds = new Set(state.items.map((it) => it.id));

  for (const id of existingIds) {
    if (!nextIds.has(id)) {
      const node = state.cardMap.get(id);
      if (node) node.remove();
      state.cardMap.delete(id);
    }
  }

  const fragment = document.createDocumentFragment();
  state.items.forEach((item, idx) => {
    const existing = state.cardMap.get(item.id);
    if (existing) {
      updateCardContents(existing, item);
    } else {
      const card = createCardElement(item, idx);
      state.cardMap.set(item.id, card);
      fragment.append(card);
    }
  });
  if (fragment.childNodes.length) {
    els.cardGrid.append(fragment);
  }
}

function refreshStats() {
  const total = state.items.length;
  const urgent7 = state.items.filter(
    (it) => it.daysLeft !== null && it.daysLeft !== undefined && it.daysLeft <= 7
  ).length;
  const urgent14 = state.items.filter(
    (it) => it.daysLeft !== null && it.daysLeft !== undefined && it.daysLeft <= 14
  ).length;
  const wlCount = state.items.filter((it) => isWatchlistMatched(it)).length;

  els.statTotal.textContent = `${total} 件`;
  els.statUrgent.textContent = `${urgent7} 件`;
  els.statTwoWeeks.textContent = `${urgent14} 件`;
  els.statWatchlist.textContent = `${wlCount} 件`;

  if (state.meta && state.meta.updatedAt) {
    const dt = new Date(state.meta.updatedAt);
    els.statUpdated.textContent = dt.toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } else {
    els.statUpdated.textContent = "未実行";
  }

  const uncheckedCount = state.items.filter((it) => !it.detailCheckedAt).length;
  els.checkDetailsOnlyBtn.hidden = total === 0 || uncheckedCount === 0;
  els.checkDetailsOnlyBtn.textContent = `期限未確認の残り日数をチェック（${uncheckedCount}件）`;
  els.exportJsonBtn.hidden = total === 0;
}

function matchesFilter(item) {
  if (state.filter === "watchlist" && !isWatchlistMatched(item)) return false;
  if (state.filter === "urgent7" && (item.daysLeft === null || item.daysLeft === undefined || item.daysLeft > 7)) {
    return false;
  }
  if (state.filter === "urgent14" && (item.daysLeft === null || item.daysLeft === undefined || item.daysLeft > 14)) {
    return false;
  }
  if (state.filter === "movie" && item.showType !== "movie") return false;
  if (state.filter === "series" && item.showType !== "series") return false;

  if (state.query) {
    const q = state.query.normalize("NFKC").toLowerCase();
    const hay = `${item.displayTitle || ""} ${item.title || ""} ${item.asin || ""} ${item.rawExpiryText || ""}`
      .normalize("NFKC")
      .toLowerCase();
    if (!hay.includes(q)) return false;
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
      const wA = isWatchlistMatched(a) ? 0 : 1;
      const wB = isWatchlistMatched(b) ? 0 : 1;
      if (wA !== wB) return wA - wB;
      if (expA !== expB) return expA - expB;
      return a.displayTitle.localeCompare(b.displayTitle, "ja");
    }
    case "title-asc":
      return a.displayTitle.localeCompare(b.displayTitle, "ja");
    case "expiry-asc":
    default:
      if (expA !== expB) return expA - expB;
      return a.displayTitle.localeCompare(b.displayTitle, "ja");
  }
}

function applyFiltersAndSort(animate = true) {
  const sorted = [...state.items].sort(compareItems);
  const visibleIds = new Set();
  const orderedNodes = [];
  for (const item of sorted) {
    const card = state.cardMap.get(item.id);
    if (!card) continue;
    if (matchesFilter(item)) visibleIds.add(item.id);
    orderedNodes.push(card);
  }
  applyDomOrder(orderedNodes, visibleIds, animate);

  const visibleCount = visibleIds.size;
  if (state.items.length === 0) {
    els.visibleCountText.textContent = "まだデータがありません。「Amazon公式から全件スキャン」を押してください。";
    els.emptyState.hidden = false;
    els.emptyScanBtn.hidden = false;
    els.resetFiltersBtn.hidden = true;
  } else {
    els.visibleCountText.textContent = `表示中: ${visibleCount} 件 / 全 ${state.items.length} 件`;
    els.emptyState.hidden = visibleCount > 0;
    els.emptyScanBtn.hidden = true;
    els.resetFiltersBtn.hidden = visibleCount > 0;
    if (visibleCount === 0) {
      els.emptyStateText.textContent =
        state.filter === "watchlist"
          ? "ウォッチリストに一致する終了予定作品はありません。「★ ウォッチリスト・設定」から同期・追加できます。"
          : "条件に一致する作品はありませんでした。";
    }
  }

  const sortLabel = els.sortSelect.options[els.sortSelect.selectedIndex]?.textContent || "";
  els.gridStatus.textContent = `${sortLabel}、${visibleCount}件を表示しています`;
}

async function toggleItemWatchlist(item) {
  const norm = normalizeTitle(item.displayTitle);
  const exists = state.watchlist.some((entry) => normalizeTitle(entry) === norm);
  if (exists) {
    state.watchlist = state.watchlist.filter((entry) => normalizeTitle(entry) !== norm);
  } else {
    state.watchlist = [...state.watchlist, item.displayTitle];
  }
  els.watchlistTextarea.value = state.watchlist.join("\n");
  rebuildCardsIfNeeded();
  refreshStats();
  applyFiltersAndSort(false);
  await persistAll();
}

function openDetailModal(item) {
  els.detailDialogTitle.textContent = item.displayTitle;
  els.detailPrimeBtn.href = item.primeLink || AMAZON_LEAVING_SOON_URL;
  els.detailDialogBody.replaceChildren();

  const layout = document.createElement("div");
  layout.className = "detail-layout";

  const img = document.createElement("img");
  img.className = "detail-poster";
  img.width = 240;
  img.height = 360;
  img.alt = `${item.displayTitle} のポスター`;
  const fallback = createFallbackPosterUri(item.displayTitle, item.showType);
  img.src = item.posterUrl || fallback;
  img.addEventListener("error", () => {
    if (img.src !== fallback) img.src = fallback;
  });

  const info = document.createElement("div");
  const ul = document.createElement("ul");
  ul.className = "detail-meta-list";
  const badge = daysBadgeMeta(item);
  const rows = [
    ["配信期限", `${item.expiresDateLabel || "30日以内"}（${badge.text}）`],
    item.rawExpiryText ? ["Amazon表示", item.rawExpiryText] : null,
    ["種別", item.showType === "series" ? "ドラマ・アニメ" : "映画"],
    item.asin ? ["ASIN", item.asin] : null,
    isWatchlistMatched(item) ? ["ウォッチリスト", "★ 一致しています"] : null,
  ].filter(Boolean);

  for (const [k, v] of rows) {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = `${k}: `;
    li.append(strong, document.createTextNode(v));
    ul.append(li);
  }
  info.append(ul);

  const overview = document.createElement("p");
  overview.className = "detail-overview";
  overview.textContent = item.overview || "（詳細ページ未取得、またはあらすじなし）";
  info.append(overview);

  layout.append(img, info);
  els.detailDialogBody.append(layout);
  els.detailDialog.showModal();
}

/* --------------------------------------------------------------------------
 * Official Amazon JP Scanner (All ~198 items + exact detail countdown)
 * ----------------------------------------------------------------------- */
async function enrichDetailsInBatches(itemsToCheck, signal) {
  const now = Date.now();
  const stale = itemsToCheck.filter(
    (it) => it.primeLink && (!it.detailCheckedAt || now - it.detailCheckedAt > DETAIL_CACHE_MS)
  );
  if (!stale.length) return { checked: 0, blocked: false };

  let checked = 0;
  let blocked = false;

  for (let i = 0; i < stale.length; i += DETAIL_BATCH_SIZE) {
    if (signal.aborted) break;
    const batch = stale.slice(i, i + DETAIL_BATCH_SIZE);

    setProgress(
      true,
      "各作品の正確な残り日数を確認中...",
      checked,
      stale.length,
      `${checked} / ${stale.length} 件確認済み（完了した作品から順次キャッシュ保存されます）`
    );

    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const resp = await fetch(item.primeLink, {
            credentials: "include",
            signal,
          });
          if (!resp.ok) return { item, detail: null };
          const html = await resp.text();
          return { item, detail: parseDetailPageHtml(html, Date.now()) };
        } catch (err) {
          if (err && err.name === "AbortError") throw err;
          return { item, detail: null };
        }
      })
    );

    for (const { item, detail } of results) {
      if (!detail) continue;
      if (detail.blocked) {
        blocked = true;
        break;
      }
      item.expiresOn = detail.expiresOn ?? item.expiresOn;
      item.expiresDate = detail.expiresDate ?? item.expiresDate;
      item.expiresDateLabel =
        detail.daysLeft !== null || detail.hoursLeft !== null
          ? detail.expiresDateLabel
          : item.daysLeft !== null
            ? item.expiresDateLabel
            : detail.expiresDateLabel;
      item.daysLeft = detail.daysLeft ?? item.daysLeft;
      item.hoursLeft = detail.hoursLeft ?? item.hoursLeft;
      item.rawExpiryText = detail.rawExpiryText || item.rawExpiryText || "";
      if (detail.overview) item.overview = detail.overview;
      if (detail.showType) item.showType = detail.showType;
      item.detailCheckedAt = Date.now();
      checked += 1;

      const card = state.cardMap.get(item.id);
      if (card) updateCardContents(card, item);
    }

    if (blocked) break;

    refreshStats();
    // Periodically persist cache every ~15 items so partial progress is never lost
    if (checked % 15 === 0 || i + DETAIL_BATCH_SIZE >= stale.length) {
      await persistAll();
    }

    if (i + DETAIL_BATCH_SIZE < stale.length) {
      await sleep(DETAIL_BATCH_DELAY_MS, signal);
    }
  }

  return { checked, blocked };
}

async function runFullOfficialScan() {
  if (state.scanning) return;
  state.scanning = true;
  state.abortController = new AbortController();
  const { signal } = state.abortController;
  showNotice("");

  const prevById = new Map(state.items.map((it) => [it.id, it]));
  const collected = new Map();

  try {
    let nextUrl = AMAZON_LEAVING_SOON_URL;
    let page = 0;
    let totalHint = null;
    let blocked = false;

    while (nextUrl && page < 25) {
      if (signal.aborted) break;
      page += 1;
      setProgress(
        true,
        `Amazon公式「30日以内に終了」一覧を取得中（${page}ページ目）...`,
        collected.size,
        totalHint || Math.max(200, collected.size + 24),
        `現在 ${collected.size} 件を取得済み${totalHint ? `（全約 ${totalHint} 件）` : ""}`
      );

      const resp = await fetch(nextUrl, { credentials: "include", signal });
      if (!resp.ok) {
        throw new Error(`Amazon ページの取得に失敗しました (HTTP ${resp.status})`);
      }
      const html = await resp.text();
      const parsed = parseSearchPageHtml(html, nextUrl, Date.now());
      if (parsed.blocked) {
        blocked = true;
        break;
      }
      if (parsed.totalHint && !totalHint) {
        totalHint = parsed.totalHint;
      }

      for (const item of parsed.items) {
        const cached = prevById.get(item.id);
        if (cached && cached.detailCheckedAt && Date.now() - cached.detailCheckedAt <= DETAIL_CACHE_MS) {
          collected.set(item.id, {
            ...item,
            expiresOn: item.expiresOn ?? cached.expiresOn,
            expiresDate: item.expiresDate ?? cached.expiresDate,
            expiresDateLabel: item.daysLeft !== null ? item.expiresDateLabel : cached.expiresDateLabel,
            daysLeft: item.daysLeft ?? cached.daysLeft,
            hoursLeft: item.hoursLeft ?? cached.hoursLeft,
            rawExpiryText: item.rawExpiryText || cached.rawExpiryText || "",
            overview: cached.overview || "",
            detailCheckedAt: cached.detailCheckedAt,
          });
        } else {
          collected.set(item.id, item);
        }
      }

      nextUrl = parsed.nextPageUrl;
      if (nextUrl) {
        await sleep(SEARCH_DELAY_MS, signal);
      }
    }

    if (blocked) {
      showNotice(
        "Amazon側で画像認証（CAPTCHA）が表示されたためスキャンを一時停止しました。Amazon.co.jp を通常タブで開いて認証を完了したあと、再度実行するか「開いているAmazonタブから取込」をお試しください。",
        "warn"
      );
    }

    if (collected.size > 0) {
      state.items = Array.from(collected.values());
      state.meta = {
        updatedAt: new Date().toISOString(),
        pagesScanned: page,
        source: "amazon-official-scan",
      };
      rebuildCardsIfNeeded();
      refreshStats();
      applyFiltersAndSort(false);
      await persistAll();

      if (!blocked && !signal.aborted) {
        const detailRes = await enrichDetailsInBatches(state.items, signal);
        if (detailRes.blocked) {
          showNotice(
            "一部の詳細ページ確認中にAmazonの確認画面が出たため中断しました。取得済みの作品はすべて保存されています。少し時間を置いて「期限未確認の残り日数をチェック」を押すと続きから確認できます。",
            "warn"
          );
        } else if (!signal.aborted) {
          showNotice(
            `Amazon公式から全 ${state.items.length} 件を取得しました（残り日数の新規確認: ${detailRes.checked} 件）。`,
            "info"
          );
        }
        rebuildCardsIfNeeded();
        refreshStats();
        applyFiltersAndSort(false);
        await persistAll();
      }
    } else if (!blocked && !signal.aborted) {
      showNotice(
        "一覧ページから作品を取得できませんでした。Amazon.co.jp にログインしているか確認するか、Amazonの「もうすぐ配信終了」ページを開いた状態で「開いているAmazonタブから取込」をお試しください。",
        "warn"
      );
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      showNotice("スキャンを中止しました。途中まで取得した作品は保存されています。", "info");
    } else {
      showNotice(`エラー: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  } finally {
    state.scanning = false;
    state.abortController = null;
    setProgress(false);
  }
}

async function runDetailsOnlyCheck() {
  if (state.scanning || !state.items.length) return;
  state.scanning = true;
  state.abortController = new AbortController();
  const { signal } = state.abortController;
  showNotice("");
  try {
    const res = await enrichDetailsInBatches(state.items, signal);
    if (res.blocked) {
      showNotice(
        "Amazonの確認画面が出たため詳細チェックを一時停止しました。確認済み分は保存されています。",
        "warn"
      );
    } else {
      showNotice(`${res.checked} 件の残り日数を更新しました。`, "info");
    }
    rebuildCardsIfNeeded();
    refreshStats();
    applyFiltersAndSort(false);
    await persistAll();
  } catch (err) {
    if (err && err.name === "AbortError") {
      showNotice("詳細チェックを中止しました。", "info");
    } else {
      showNotice(`エラー: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  } finally {
    state.scanning = false;
    state.abortController = null;
    setProgress(false);
  }
}

/* --------------------------------------------------------------------------
 * Capture from currently open Amazon / Prime Video tab
 * ----------------------------------------------------------------------- */
async function captureFromOpenAmazonTab() {
  if (state.scanning) return;
  showNotice("");

  const tabs = await chrome.tabs.query({
    url: ["https://www.amazon.co.jp/*", "https://www.primevideo.com/*"],
  });

  if (!tabs.length) {
    showNotice(
      "開いている Amazon / Prime Video のタブが見つかりませんでした。先にAmazonの「30日以内に終了」または Prime Video ページを開いてから再実行してください。",
      "warn"
    );
    return;
  }

  // Prefer the most recently active / leaving-soon tab
  const preferred =
    tabs.find((t) => t.url && /4217521051|leaving|watchlist/i.test(t.url)) ||
    tabs.find((t) => t.active) ||
    tabs[0];

  if (preferred.id === undefined) return;

  try {
    let response;
    try {
      response = await chrome.tabs.sendMessage(preferred.id, { type: "CAPTURE_AMAZON_DOM" });
    } catch (_) {
      // Inject content script on demand if tab was open before extension install
      await chrome.scripting.executeScript({
        target: { tabId: preferred.id },
        files: ["content/amazon-capture.js"],
      });
      response = await chrome.tabs.sendMessage(preferred.id, { type: "CAPTURE_AMAZON_DOM" });
    }

    if (!response || !response.ok || !Array.isArray(response.items) || !response.items.length) {
      showNotice(
        "タブから作品カードを取得できませんでした。対象の Amazon ページを下にスクロールして作品を表示してから再実行してください。",
        "warn"
      );
      return;
    }

    const merged = new Map(state.items.map((it) => [it.id, it]));
    let added = 0;

    for (const raw of response.items) {
      const existing = merged.get(raw.id);
      const inlineExp = parseExpiryText(raw.cardText || "", Date.now());
      if (existing) {
        if (inlineExp && existing.daysLeft === null) {
          existing.expiresOn = inlineExp.expiresOn;
          existing.expiresDate = inlineExp.expiresDate;
          existing.expiresDateLabel = inlineExp.expiresDateLabel;
          existing.daysLeft = inlineExp.daysLeft;
          existing.hoursLeft = inlineExp.hoursLeft;
          existing.rawExpiryText = inlineExp.rawExpiryText;
        }
        if (!existing.posterUrl && raw.posterUrl) existing.posterUrl = raw.posterUrl;
      } else {
        added += 1;
        merged.set(raw.id, {
          id: raw.id,
          asin: raw.asin || "",
          displayTitle: raw.displayTitle,
          title: raw.title,
          originalTitle: "",
          showType: /シーズン|season/i.test(`${raw.displayTitle} ${raw.cardText || ""}`)
            ? "series"
            : "movie",
          posterUrl: raw.posterUrl || "",
          primeLink: raw.primeLink || AMAZON_LEAVING_SOON_URL,
          expiresOn: inlineExp ? inlineExp.expiresOn : null,
          expiresDate: inlineExp ? inlineExp.expiresDate : null,
          expiresDateLabel: inlineExp ? inlineExp.expiresDateLabel : "30日以内（確認待ち）",
          daysLeft: inlineExp ? inlineExp.daysLeft : null,
          hoursLeft: inlineExp ? inlineExp.hoursLeft : null,
          rawExpiryText: inlineExp ? inlineExp.rawExpiryText : "",
          detailCheckedAt: 0,
          source: "open-tab-capture",
        });
      }
    }

    state.items = Array.from(merged.values());
    state.meta = {
      updatedAt: new Date().toISOString(),
      source: "open-tab-capture",
    };
    rebuildCardsIfNeeded();
    refreshStats();
    applyFiltersAndSort(false);
    await persistAll();

    showNotice(
      `タブ「${response.pageTitle || preferred.title || "Amazon"}」から ${response.items.length} 件を取り込みました（新規追加: ${added} 件）。必要に応じて「期限未確認の残り日数をチェック」で正確な終了日を取得できます。`,
      "info"
    );
  } catch (err) {
    showNotice(`タブ取り込みエラー: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/* --------------------------------------------------------------------------
 * Watchlist auto-sync & settings modal
 * ----------------------------------------------------------------------- */
async function syncAmazonWatchlist() {
  els.watchlistFeedback.textContent = "Amazonウォッチリストを取得中...";
  try {
    let titles = [];

    // 1. Check if a Watchlist tab is already open (captures client-rendered SPA items reliably)
    const openWlTabs = await chrome.tabs.query({
      url: [
        "https://www.amazon.co.jp/gp/video/mystuff*",
        "https://www.primevideo.com/mystuff*",
      ],
    });
    if (openWlTabs.length && openWlTabs[0].id !== undefined) {
      try {
        const res = await chrome.tabs.sendMessage(openWlTabs[0].id, { type: "CAPTURE_AMAZON_DOM" });
        if (res && res.ok && Array.isArray(res.items) && res.items.length) {
          titles = res.items.map((x) => x.displayTitle);
        }
      } catch (_) {}
    }

    // 2. Fallback: direct fetch with logged-in cookies
    if (!titles.length) {
      const resp = await fetch(AMAZON_WATCHLIST_URL, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const parsed = parseWatchlistHtml(html);
      if (parsed.blocked) {
        els.watchlistFeedback.textContent =
          "Amazonの確認画面が出ました。先にウォッチリスト画面をタブで開いてからもう一度押してください。";
        return;
      }
      titles = parsed.titles;
    }

    if (!titles.length) {
      els.watchlistFeedback.textContent =
        "取得できませんでした。「ウォッチリストを開く」からログイン状態で表示し、そのまま再度「自動同期」を押してください。";
      return;
    }

    const merged = [];
    const seen = new Set();
    for (const t of [...state.watchlist, ...titles]) {
      const clean = String(t || "").trim();
      const norm = normalizeTitle(clean);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        merged.push(clean);
      }
    }
    state.watchlist = merged;
    els.watchlistTextarea.value = merged.join("\n");
    rebuildCardsIfNeeded();
    refreshStats();
    applyFiltersAndSort(false);
    await persistAll();
    els.watchlistFeedback.textContent = `${titles.length} 件のウォッチリスト作品を取り込みました（合計 ${merged.length} 件）。`;
  } catch (err) {
    els.watchlistFeedback.textContent = `取得エラー: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function exportAsJson() {
  const now = new Date();
  const doc = {
    updatedAt: now.toISOString(),
    updatedAtLabel: now.toLocaleString("ja-JP"),
    isDemo: false,
    country: "jp",
    catalog: "prime.subscription (amazon-official-extension)",
    provider: "chrome-extension",
    amazonLeavingSoonUrl: AMAZON_LEAVING_SOON_URL,
    totalCount: state.items.length,
    watchlistCount: state.items.filter((it) => isWatchlistMatched(it)).length,
    urgentCount: state.items.filter(
      (it) => it.daysLeft !== null && it.daysLeft !== undefined && it.daysLeft <= 7
    ).length,
    items: [...state.items].sort(compareItems).map((it) => ({
      ...it,
      inWatchlist: isWatchlistMatched(it),
    })),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "expiring.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------------------------------------------------------
 * Event wiring & Boot
 * ----------------------------------------------------------------------- */
function initEvents() {
  els.scanFullBtn.addEventListener("click", runFullOfficialScan);
  els.emptyScanBtn.addEventListener("click", runFullOfficialScan);
  els.checkDetailsOnlyBtn.addEventListener("click", runDetailsOnlyCheck);
  els.captureTabBtn.addEventListener("click", captureFromOpenAmazonTab);
  els.exportJsonBtn.addEventListener("click", exportAsJson);

  els.cancelScanBtn.addEventListener("click", () => {
    if (state.abortController) state.abortController.abort();
  });

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

  els.openSettingsBtn.addEventListener("click", () => {
    els.watchlistTextarea.value = state.watchlist.join("\n");
    els.autoScanCheckbox.checked = Boolean(state.settings.autoScanEnabled);
    els.autoScanIntervalSelect.value = String(state.settings.autoScanIntervalHours || 12);
    els.desktopNotifyCheckbox.checked = state.settings.desktopNotifyEnabled !== false;
    els.discordWebhookInput.value = state.settings.discordWebhookUrl || "";
    els.watchlistFeedback.textContent = "";
    els.settingsFeedback.textContent = "";
    els.settingsDialog.showModal();
  });

  els.syncWatchlistBtn.addEventListener("click", syncAmazonWatchlist);

  els.saveWatchlistBtn.addEventListener("click", async () => {
    const lines = els.watchlistTextarea.value.split(/\r?\n/);
    const cleaned = [];
    const seen = new Set();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const norm = normalizeTitle(t);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        cleaned.push(t);
      }
    }
    state.watchlist = cleaned;
    els.watchlistTextarea.value = cleaned.join("\n");
    rebuildCardsIfNeeded();
    refreshStats();
    applyFiltersAndSort(false);
    await persistAll();
    els.watchlistFeedback.textContent = `${cleaned.length} 件を保存して反映しました。`;
  });

  els.saveSettingsBtn.addEventListener("click", async () => {
    const webhookUrl = els.discordWebhookInput.value.trim();
    if (webhookUrl) {
      try {
        const origin = new URL(webhookUrl).origin + "/*";
        // Request optional host permission immediately within click gesture (no prior await)
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          els.settingsFeedback.textContent = "Discord送信権限が拒否されたためWebhookを保存できませんでした。";
          return;
        }
      } catch (_) {
        els.settingsFeedback.textContent = "Discord Webhook URLの形式が正しくありません。";
        return;
      }
    }

    state.settings = {
      ...state.settings,
      autoScanEnabled: els.autoScanCheckbox.checked,
      autoScanIntervalHours: Number(els.autoScanIntervalSelect.value || 12),
      desktopNotifyEnabled: els.desktopNotifyCheckbox.checked,
      discordWebhookUrl: webhookUrl,
    };
    await persistAll();
    els.settingsFeedback.textContent = "設定を保存しました。";
  });

  els.testDiscordBtn.addEventListener("click", async () => {
    const webhookUrl = els.discordWebhookInput.value.trim();
    if (!webhookUrl) {
      els.settingsFeedback.textContent = "先に Discord Webhook URL を入力してください。";
      return;
    }
    try {
      const origin = new URL(webhookUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        els.settingsFeedback.textContent = "Discord送信権限が必要です。";
        return;
      }
      els.settingsFeedback.textContent = "テスト送信中...";
      const res = await chrome.runtime.sendMessage({
        type: "SEND_DISCORD_TEST",
        webhookUrl,
      });
      els.settingsFeedback.textContent =
        res && res.ok ? "Discordへテスト通知を送信しました！" : `送信エラー: ${res?.error || "不明"}`;
    } catch (err) {
      els.settingsFeedback.textContent = `送信エラー: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
}

async function boot() {
  initColorScheme();
  attachLightDismissFallback(els.settingsDialog);
  attachLightDismissFallback(els.detailDialog);
  initEvents();

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ITEMS,
    STORAGE_KEYS.META,
    STORAGE_KEYS.WATCHLIST,
    STORAGE_KEYS.SETTINGS,
  ]);
  state.items = Array.isArray(stored[STORAGE_KEYS.ITEMS]) ? stored[STORAGE_KEYS.ITEMS] : [];
  state.meta = stored[STORAGE_KEYS.META] || null;
  state.watchlist = Array.isArray(stored[STORAGE_KEYS.WATCHLIST]) ? stored[STORAGE_KEYS.WATCHLIST] : [];
  state.settings = { ...state.settings, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };

  rebuildCardsIfNeeded();
  refreshStats();
  applyFiltersAndSort(false);
}

boot();
