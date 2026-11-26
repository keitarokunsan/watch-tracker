/**
 * MV3 Service Worker for Prime Video 見放題終了トラッカー (JP).
 * Stateless: all persistent state is stored in chrome.storage.local,
 * and scheduled checks run via chrome.alarms.
 */

import {
  AMAZON_LEAVING_SOON_URL,
  matchWatchlist,
  parseDetailPageHtml,
  parseSearchPageHtml,
} from "../lib/amazon-parser.js";

const ALARM_NAME = "prime-expiring-auto-check";
const STORAGE_KEYS = {
  ITEMS: "expiringItems",
  META: "scanMeta",
  WATCHLIST: "watchlistEntries",
  SETTINGS: "userSettings",
  HISTORY: "notifiedHistory",
};

const DEFAULT_SETTINGS = {
  autoScanEnabled: false,
  autoScanIntervalHours: 12,
  desktopNotifyEnabled: true,
  discordWebhookUrl: "",
  detailCacheHours: 12,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openOrFocusDashboard() {
  const dashboardUrl = chrome.runtime.getURL("dashboard/dashboard.html");
  const existing = await chrome.tabs.query({ url: dashboardUrl });
  if (existing.length > 0 && existing[0].id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId !== undefined) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: dashboardUrl });
}

async function updateBadge(items, watchlistEntries) {
  const wlCount = items.filter((it) =>
    Boolean(matchWatchlist([it.displayTitle, it.title], watchlistEntries))
  ).length;
  const urgentCount = items.filter(
    (it) => it.daysLeft !== null && it.daysLeft !== undefined && it.daysLeft <= 3
  ).length;

  if (wlCount > 0) {
    await chrome.action.setBadgeText({ text: String(wlCount) });
    await chrome.action.setBadgeBackgroundColor({ color: "#D97706" });
  } else if (urgentCount > 0) {
    await chrome.action.setBadgeText({ text: String(urgentCount) });
    await chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function syncAlarmFromSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.autoScanEnabled) {
    const periodMinutes = Math.max(60, Number(settings.autoScanIntervalHours || 12) * 60);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodMinutes });
  }
}

async function sendDiscordAlerts(webhookUrl, watchlistAlerts, newCount, totalCount) {
  if (!webhookUrl) return;
  const lines = watchlistAlerts.slice(0, 20).map((it) => {
    const daysText =
      it.hoursLeft !== null && it.hoursLeft !== undefined
        ? `あと約${it.hoursLeft}時間`
        : it.daysLeft !== null && it.daysLeft !== undefined
          ? it.daysLeft <= 0
            ? "本日終了"
            : `あと${it.daysLeft}日`
          : "30日以内";
    return `• **[${it.displayTitle}](${it.primeLink})** — \`${it.expiresDateLabel}\`（${daysText}）`;
  });

  const payload = {
    content: `**Prime Video 見放題終了アラート（Chrome拡張）**\n[Amazon公式: 30日以内に終了一覧](${AMAZON_LEAVING_SOON_URL})`,
    embeds: [
      {
        title: watchlistAlerts.length
          ? `★ ウォッチリスト作品の終了予定（${watchlistAlerts.length}件）`
          : `新規に配信終了予定を検出（+${newCount}件）`,
        description:
          lines.join("\n") ||
          `新たに ${newCount} 件の作品が「30日以内に終了」に追加されました（合計 ${totalCount} 件）。`,
        color: watchlistAlerts.length ? 0xf59e0b : 0x00a8e1,
      },
    ],
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function notifyIfNeeded(items, watchlistEntries, settings) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const history = stored[STORAGE_KEYS.HISTORY] || { seenIds: [] };
  const prevSeen = new Set(Array.isArray(history.seenIds) ? history.seenIds : []);

  const newItems = items.filter((it) => !prevSeen.has(it.id));
  const newWatchlist = newItems.filter((it) =>
    Boolean(matchWatchlist([it.displayTitle, it.title], watchlistEntries))
  );

  await chrome.storage.local.set({
    [STORAGE_KEYS.HISTORY]: {
      seenIds: items.map((it) => it.id),
      updatedAt: new Date().toISOString(),
    },
  });

  if (prevSeen.size === 0 || (!newItems.length && !newWatchlist.length)) {
    return;
  }

  if (settings.desktopNotifyEnabled) {
    const title = newWatchlist.length
      ? `★ ウォッチリスト ${newWatchlist.length} 件がまもなく配信終了`
      : `Prime Video 配信終了予定が ${newItems.length} 件追加`;
    const sampleNames = (newWatchlist.length ? newWatchlist : newItems)
      .slice(0, 3)
      .map((x) => x.displayTitle)
      .join(" / ");
    await chrome.notifications.create(`prime-expiring-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message: `${sampleNames}（合計 ${items.length} 件）`,
    });
  }

  if (settings.discordWebhookUrl) {
    try {
      const origin = new URL(settings.discordWebhookUrl).origin + "/*";
      const hasPerm = await chrome.permissions.contains({ origins: [origin] });
      if (hasPerm) {
        await sendDiscordAlerts(settings.discordWebhookUrl, newWatchlist, newItems.length, items.length);
      }
    } catch (err) {
      console.warn("Discord notification skipped:", err);
    }
  }
}

/**
 * Lightweight background scan triggered by chrome.alarms:
 * Scans all search pages of Amazon JP's 30-day leaving list, merges with cached
 * detail expiry info, and updates badge/notifications.
 */
async function runBackgroundAlarmScan() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ITEMS,
    STORAGE_KEYS.WATCHLIST,
    STORAGE_KEYS.SETTINGS,
  ]);
  const prevItems = Array.isArray(stored[STORAGE_KEYS.ITEMS]) ? stored[STORAGE_KEYS.ITEMS] : [];
  const prevById = new Map(prevItems.map((it) => [it.id, it]));
  const watchlistEntries = Array.isArray(stored[STORAGE_KEYS.WATCHLIST])
    ? stored[STORAGE_KEYS.WATCHLIST]
    : [];
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };

  const collected = new Map();
  let nextUrl = AMAZON_LEAVING_SOON_URL;
  let pages = 0;

  while (nextUrl && pages < 20) {
    const resp = await fetch(nextUrl, { credentials: "include" });
    if (!resp.ok) break;
    const html = await resp.text();
    const parsed = parseSearchPageHtml(html, nextUrl, Date.now());
    if (parsed.blocked) {
      console.warn("Amazon CAPTCHA detected during background alarm scan; stopping cleanly.");
      return;
    }
    for (const item of parsed.items) {
      const cached = prevById.get(item.id);
      if (cached && cached.detailCheckedAt) {
        collected.set(item.id, {
          ...item,
          expiresOn: item.expiresOn ?? cached.expiresOn,
          expiresDate: item.expiresDate ?? cached.expiresDate,
          expiresDateLabel:
            item.daysLeft !== null ? item.expiresDateLabel : cached.expiresDateLabel,
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
    pages += 1;
    nextUrl = parsed.nextPageUrl;
    if (nextUrl) await sleep(500);
  }

  if (!collected.size) return;

  // Enrich up to 15 newly-discovered items politely inside background alarm
  const unchecked = Array.from(collected.values())
    .filter((it) => !it.detailCheckedAt)
    .slice(0, 15);
  for (const item of unchecked) {
    try {
      const resp = await fetch(item.primeLink, { credentials: "include" });
      if (!resp.ok) continue;
      const html = await resp.text();
      const detail = parseDetailPageHtml(html, Date.now());
      if (detail.blocked) break;
      Object.assign(item, {
        expiresOn: detail.expiresOn,
        expiresDate: detail.expiresDate,
        expiresDateLabel: detail.expiresDateLabel,
        daysLeft: detail.daysLeft,
        hoursLeft: detail.hoursLeft,
        rawExpiryText: detail.rawExpiryText,
        overview: detail.overview || item.overview || "",
        detailCheckedAt: Date.now(),
      });
      await sleep(400);
    } catch (_) {
      // Ignore single-item transient failure
    }
  }

  const finalItems = Array.from(collected.values());
  await chrome.storage.local.set({
    [STORAGE_KEYS.ITEMS]: finalItems,
    [STORAGE_KEYS.META]: {
      updatedAt: new Date().toISOString(),
      pagesScanned: pages,
      source: "alarm-background",
    },
  });

  await updateBadge(finalItems, watchlistEntries);
  await notifyIfNeeded(finalItems, watchlistEntries, settings);
}

// Synchronous top-level event listeners (MV3 requirement)
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  await syncAlarmFromSettings();
});

chrome.action.onClicked.addListener(async () => {
  await openOrFocusDashboard();
});

chrome.notifications.onClicked.addListener(async () => {
  await openOrFocusDashboard();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    try {
      await runBackgroundAlarmScan();
    } catch (err) {
      console.error("Background alarm scan error:", err);
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "SYNC_ALARM_AND_BADGE") {
    (async () => {
      try {
        await syncAlarmFromSettings();
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.ITEMS,
          STORAGE_KEYS.WATCHLIST,
        ]);
        await updateBadge(
          Array.isArray(stored[STORAGE_KEYS.ITEMS]) ? stored[STORAGE_KEYS.ITEMS] : [],
          Array.isArray(stored[STORAGE_KEYS.WATCHLIST]) ? stored[STORAGE_KEYS.WATCHLIST] : []
        );
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.type === "SEND_DISCORD_TEST") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.ITEMS,
          STORAGE_KEYS.WATCHLIST,
        ]);
        const items = Array.isArray(stored[STORAGE_KEYS.ITEMS]) ? stored[STORAGE_KEYS.ITEMS] : [];
        const wl = Array.isArray(stored[STORAGE_KEYS.WATCHLIST]) ? stored[STORAGE_KEYS.WATCHLIST] : [];
        const wlMatches = items.filter((it) =>
          Boolean(matchWatchlist([it.displayTitle, it.title], wl))
        );
        const sample = wlMatches.length ? wlMatches : items.slice(0, 10);
        await sendDiscordAlerts(message.webhookUrl, sample, sample.length, items.length);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  return false;
});
