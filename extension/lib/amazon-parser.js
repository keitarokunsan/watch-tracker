/**
 * Pure-JS HTML/JSON/text parser for Amazon.co.jp & PrimeVideo.com expiring titles.
 * Designed with ZERO DOMParser dependency so it runs identically in:
 *   - MV3 Service Workers
 *   - Extension Dashboard pages
 *   - Node.js unit tests
 */

export const AMAZON_LEAVING_SOON_URL = "https://www.amazon.co.jp/s?rh=n%3A4217521051";
export const AMAZON_WATCHLIST_URL = "https://www.amazon.co.jp/gp/video/mystuff/watchlist";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeHtmlEntities(input) {
  if (!input) return "";
  return String(input)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (full, code) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        const cp = Number.parseInt(code.slice(2), 16);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
      }
      if (code.startsWith("#")) {
        const cp = Number.parseInt(code.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
      }
      return Object.hasOwn(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : full;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripTags(html) {
  if (!html) return "";
  return decodeHtmlEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

const STRIP_RE =
  /[\s\u3000\-‐‑‒–—―~〜～:：;；!！?？.,。、・･'’"“”()（）\[\]【】「」『』/／\\|_]+/g;
const SUFFIX_RE =
  /(?:\s*(?:シーズン|season|part|パート|第)\s*\d+.*|\s*\((?:字幕版|吹替版|吹き替え版|日本語吹替版|4k|uhd|hd)\)|\s*（(?:字幕版|吹替版|吹き替え版|日本語吹替版|4k|uhd|hd)）)$/i;

export function normalizeTitle(text) {
  if (!text) return "";
  return String(text)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(SUFFIX_RE, "")
    .trim()
    .replace(STRIP_RE, "");
}

export function matchWatchlist(candidateTitles, watchlistEntries) {
  const normCandidates = (candidateTitles || []).map(normalizeTitle).filter(Boolean);
  if (!normCandidates.length) return null;

  for (const entry of watchlistEntries || []) {
    const normEntry = normalizeTitle(entry);
    if (!normEntry) continue;
    for (const cand of normCandidates) {
      if (normEntry === cand) return entry;
      if (normEntry.length >= 3 && (cand.includes(normEntry) || normEntry.includes(cand))) {
        return entry;
      }
    }
  }
  return null;
}

export function detectCaptchaOrBlock(html) {
  if (!html || typeof html !== "string") return false;
  const sample = html.slice(0, 80000);
  return (
    /errors\/validateCaptcha/i.test(sample) ||
    /id=["']captchacharacters["']/i.test(sample) ||
    /ロボットではないことを確認/.test(sample) ||
    /Type the characters you see/i.test(sample) ||
    /Enter the characters you see below/i.test(sample) ||
    /自動アクセス/.test(sample)
  );
}

export function formatJstDate(ms) {
  const jst = new Date(ms + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const wd = WEEKDAYS_JA[jst.getUTCDay()];
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    expiresDate: `${year}-${mm}-${dd}`,
    expiresDateLabel: `${month}/${day} (${wd})`,
    expiresAt: `${year}-${mm}-${dd}T23:59:00+09:00`,
  };
}

function jstStartOfDayUtcMs(ms) {
  const jst = new Date(ms + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();
  return Date.UTC(y, m, d, 0, 0, 0) - JST_OFFSET_MS;
}

/**
 * Parse Japanese or English Prime Video expiration text into structured fields.
 */
export function parseExpiryText(text, nowMs = Date.now()) {
  if (!text) return null;
  const normalized = String(text).normalize("NFKC");

  // 1. Hours remaining: "Primeでの配信は18時間以内に終了" / "あと5時間以内に終了" / "Leaves Prime in 12 hours"
  const hoursMatch =
    normalized.match(/(?:Prime[^\n。0-9]{0,16}|プライム[^\n。0-9]{0,16}|あと)?(?<!\d)(\d{1,3})\s*時間以内に(?:終了|プライム会員特典ではなくな)/i) ||
    normalized.match(/Leaves\s+Prime\s+in\s+(\d{1,3})\s+hours?/i);
  if (hoursMatch) {
    const hours = Number.parseInt(hoursMatch[1], 10);
    if (Number.isFinite(hours) && hours >= 0 && hours <= 240) {
      const targetMs = nowMs + hours * 3600 * 1000;
      const fmt = formatJstDate(targetMs);
      const dayDiff = Math.max(
        0,
        Math.round((jstStartOfDayUtcMs(targetMs) - jstStartOfDayUtcMs(nowMs)) / 86400000)
      );
      return {
        daysLeft: dayDiff,
        hoursLeft: hours,
        expiresOn: Math.floor(targetMs / 1000),
        expiresDate: fmt.expiresDate,
        expiresDateLabel: `${fmt.expiresDateLabel}（あと約${hours}時間）`,
        rawExpiryText: hoursMatch[0].trim(),
      };
    }
  }

  // 2. Days remaining: "Primeでの配信は5日以内に終了" / "14日以内に終了" / "Leaves Prime in 5 days"
  const daysPatterns = [
    /(?:Prime[^\n。0-9]{0,16}|プライム[^\n。0-9]{0,16}|あと)?(?<!\d)(\d{1,2})\s*日以内に(?:終了|プライム会員特典ではなくな)/gi,
    /Leaves\s+Prime\s+in\s+(\d{1,2})\s+days?/gi,
  ];
  let generic30DayMatch = null;
  for (const re of daysPatterns) {
    for (const daysMatch of normalized.matchAll(re)) {
      const days = Number.parseInt(daysMatch[1], 10);
      if (!Number.isFinite(days) || days < 0 || days > 60) continue;
      // Ignore generic category headings like "30日以内にプライム会員特典ではなくなる作品" when scanning for exact countdowns
      const around = normalized.slice(daysMatch.index, daysMatch.index + 40);
      if (days === 30 && /作品/.test(around)) {
        generic30DayMatch = daysMatch[0].trim();
        continue;
      }
      const targetMs = jstStartOfDayUtcMs(nowMs) + days * 86400000 + (23 * 3600 + 59 * 60) * 1000;
      const fmt = formatJstDate(targetMs);
      return {
        daysLeft: days,
        hoursLeft: null,
        expiresOn: Math.floor(targetMs / 1000),
        expiresDate: fmt.expiresDate,
        expiresDateLabel: `${fmt.expiresDateLabel} 頃`,
        rawExpiryText: daysMatch[0].trim(),
      };
    }
  }

  // 3. Explicit YYYY年M月D日 or YYYY/M/D with expiry context
  const fullDateMatch = normalized.match(
    /(?:プライム|Prime|見放題|配信)[^\n。]{0,20}?(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?(?:まで|に終了|で終了)/i
  );
  if (fullDateMatch) {
    const year = Number.parseInt(fullDateMatch[1], 10);
    const month = Number.parseInt(fullDateMatch[2], 10);
    const day = Number.parseInt(fullDateMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const targetMs = Date.UTC(year, month - 1, day, 23, 59, 0) - JST_OFFSET_MS;
      const fmt = formatJstDate(targetMs);
      const daysLeft = Math.round(
        (jstStartOfDayUtcMs(targetMs) - jstStartOfDayUtcMs(nowMs)) / 86400000
      );
      return {
        daysLeft,
        hoursLeft: null,
        expiresOn: Math.floor(targetMs / 1000),
        expiresDate: fmt.expiresDate,
        expiresDateLabel: fmt.expiresDateLabel,
        rawExpiryText: fullDateMatch[0].trim(),
      };
    }
  }

  // 4. Explicit M月D日まで / M月D日に終了
  const mdMatch = normalized.match(
    /(?:プライム|Prime|見放題|配信)[^\n。]{0,20}?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:まで|に終了|で終了)/i
  );
  if (mdMatch) {
    const month = Number.parseInt(mdMatch[1], 10);
    const day = Number.parseInt(mdMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const nowJst = new Date(nowMs + JST_OFFSET_MS);
      let year = nowJst.getUTCFullYear();
      let targetMs = Date.UTC(year, month - 1, day, 23, 59, 0) - JST_OFFSET_MS;
      if (targetMs < nowMs - 7 * 86400000) {
        year += 1;
        targetMs = Date.UTC(year, month - 1, day, 23, 59, 0) - JST_OFFSET_MS;
      }
      const fmt = formatJstDate(targetMs);
      const daysLeft = Math.round(
        (jstStartOfDayUtcMs(targetMs) - jstStartOfDayUtcMs(nowMs)) / 86400000
      );
      return {
        daysLeft,
        hoursLeft: null,
        expiresOn: Math.floor(targetMs / 1000),
        expiresDate: fmt.expiresDate,
        expiresDateLabel: fmt.expiresDateLabel,
        rawExpiryText: mdMatch[0].trim(),
      };
    }
  }

  // 5. "まもなく配信終了" / "今日終了"
  if (/本日(?:で|に)?(?:配信)?終了|今日(?:で|に)?(?:配信)?終了|Leaves\s+Prime\s+today/i.test(normalized)) {
    const targetMs = jstStartOfDayUtcMs(nowMs) + (23 * 3600 + 59 * 60) * 1000;
    const fmt = formatJstDate(targetMs);
    return {
      daysLeft: 0,
      hoursLeft: null,
      expiresOn: Math.floor(targetMs / 1000),
      expiresDate: fmt.expiresDate,
      expiresDateLabel: fmt.expiresDateLabel,
      rawExpiryText: "本日終了",
    };
  }

  if (generic30DayMatch) {
    return {
      daysLeft: null,
      hoursLeft: null,
      expiresOn: null,
      expiresDate: null,
      expiresDateLabel: "30日以内（詳細日付なし）",
      rawExpiryText: generic30DayMatch,
    };
  }

  return null;
}

function upgradeAmazonImageUrl(url) {
  if (!url || !url.startsWith("http")) return "";
  // Upgrade low-res search thumbnails (_AC_UY218_, _AC_UL320_) for sharper poster cards
  return url.replace(/_AC_U[XYLR]\d+_/i, "_AC_UL480_");
}

export function normalizeAmazonVideoUrl(href, asin, origin = "https://www.amazon.co.jp") {
  if (asin) {
    return `${origin}/gp/video/detail/${asin}`;
  }
  if (!href) return AMAZON_LEAVING_SOON_URL;
  const decoded = decodeHtmlEntities(href);
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
    return decoded;
  }
  return `${origin}${decoded.startsWith("/") ? "" : "/"}${decoded}`;
}

export function extractAsinFromUrl(url) {
  if (!url) return "";
  const m = String(url).match(/\/(?:gp\/video\/detail|detail|dp)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
  return m ? m[1].toUpperCase() : "";
}

function inferShowTypeFromTitle(title) {
  if (!title) return "movie";
  if (/(?:シーズン\s*\d+|Season\s*\d+|第\d+期|全\d+話)/i.test(String(title))) {
    return "series";
  }
  return "movie";
}

function inferShowTypeFromDetailHtml(html, title) {
  // 1. Amazon Prime Video embedded JSON titleType (most reliable)
  const titleTypeM = html.match(/"titleType"\s*:\s*"(MOVIE|SEASON|TV_SHOW|SERIES|EPISODE)"/i);
  if (titleTypeM) {
    return titleTypeM[1].toUpperCase() === "MOVIE" ? "movie" : "series";
  }
  // 2. JSON-LD @type
  const ldTypeM = html.match(/"@type"\s*:\s*"(Movie|TVSeries|TVSeason|TVEpisode)"/i);
  if (ldTypeM) {
    return ldTypeM[1].toLowerCase() === "movie" ? "movie" : "series";
  }
  // 3. OpenGraph video type
  const ogTypeM =
    html.match(/<meta\b[^>]*property=["']og:type["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:type["']/i);
  if (ogTypeM) {
    const ogType = ogTypeM[1].toLowerCase();
    if (ogType.includes("movie")) return "movie";
    if (ogType.includes("tv") || ogType.includes("episode") || ogType.includes("series")) {
      return "series";
    }
  }
  // 4. Fallback: title pattern only (never scan page header navigation text)
  return inferShowTypeFromTitle(title);
}

/**
 * Parse an Amazon.co.jp search results page (e.g. /s?rh=n%3A4217521051&page=1).
 */
export function parseSearchPageHtml(html, baseUrl = "https://www.amazon.co.jp", nowMs = Date.now()) {
  if (detectCaptchaOrBlock(html)) {
    return {
      blocked: true,
      items: [],
      nextPageUrl: null,
      totalHint: null,
    };
  }

  const origin = new URL(baseUrl).origin;
  const items = [];
  const seenAsins = new Set();

  // Extract total results count hint e.g. "198件の検索結果" or "検索結果 198 のうち 1-16件"
  let totalHint = null;
  const totalMatch =
    html.match(/検索結果\s*([\d,]+)\s*(?:件|のうち)/) ||
    html.match(/([\d,]+)\s*件のうち/) ||
    html.match(/of\s+(?:over\s+)?([\d,]+)\s+results/i);
  if (totalMatch) {
    const parsedTotal = Number.parseInt(totalMatch[1].replace(/,/g, ""), 10);
    if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
      totalHint = parsedTotal;
    }
  }

  // Locate each search result card by data-component-type="s-search-result"
  const cardStarts = [];
  const cardMarkerRe = /<div\b[^>]*data-component-type=["']s-search-result["'][^>]*>/gi;
  let m;
  while ((m = cardMarkerRe.exec(html)) !== null) {
    cardStarts.push({ index: m.index, openTag: m[0] });
  }

  for (let i = 0; i < cardStarts.length; i++) {
    const start = cardStarts[i].index;
    const end = i + 1 < cardStarts.length ? cardStarts[i + 1].index : Math.min(html.length, start + 30000);
    const chunk = html.slice(start, end);
    const openTag = cardStarts[i].openTag;

    const asinMatch = openTag.match(/data-asin=["']([A-Z0-9]{10})["']/i);
    if (!asinMatch) continue;
    const asin = asinMatch[1].toUpperCase();
    if (seenAsins.has(asin)) continue;
    seenAsins.add(asin);

    // Title: prefer <h2> text, fallback to <img class="s-image" alt="...">
    let title = "";
    const h2Match = chunk.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      title = stripTags(h2Match[1]);
    }

    let posterUrl = "";
    const imgTagMatch = chunk.match(/<img\b[^>]*class=["'][^"']*s-image[^"']*["'][^>]*>/i);
    if (imgTagMatch) {
      const tag = imgTagMatch[0];
      const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
      if (srcMatch) posterUrl = upgradeAmazonImageUrl(decodeHtmlEntities(srcMatch[1]));
      if (!title) {
        const altMatch = tag.match(/\balt=["']([^"']+)["']/i);
        if (altMatch) title = decodeHtmlEntities(altMatch[1]);
      }
    }

    if (!title) continue;

    // Video detail link
    const hrefMatch = chunk.match(/href=["']([^"']*(?:\/gp\/video\/detail\/|\/dp\/)[A-Z0-9]{10}[^"']*)["']/i);
    const primeLink = normalizeAmazonVideoUrl(hrefMatch ? hrefMatch[1] : "", asin, origin);

    const cardText = stripTags(chunk);
    const expiry = parseExpiryText(cardText, nowMs);

    const yearMatch = cardText.match(/\b(19\d{2}|20[0-3]\d)\b/);
    const releaseYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;

    items.push({
      id: asin,
      asin,
      displayTitle: title,
      title,
      originalTitle: "",
      showType: inferShowTypeFromTitle(title),
      releaseYear,
      posterUrl,
      primeLink,
      expiresOn: expiry ? expiry.expiresOn : null,
      expiresDate: expiry ? expiry.expiresDate : null,
      expiresDateLabel: expiry ? expiry.expiresDateLabel : "30日以内（確認待ち）",
      daysLeft: expiry ? expiry.daysLeft : null,
      hoursLeft: expiry ? expiry.hoursLeft : null,
      rawExpiryText: expiry ? expiry.rawExpiryText : "",
      detailCheckedAt: 0,
      source: "amazon-search",
    });
  }

  // Next pagination link (ignore disabled span/a)
  let nextPageUrl = null;
  const nextAnchorRe = /<a\b[^>]*class=["'][^"']*s-pagination-next[^"']*["'][^>]*>/gi;
  let nm;
  while ((nm = nextAnchorRe.exec(html)) !== null) {
    const tag = nm[0];
    if (/s-pagination-disabled/i.test(tag) || /aria-disabled=["']true["']/i.test(tag)) {
      continue;
    }
    const hrefM = tag.match(/\bhref=["']([^"']+)["']/i);
    if (hrefM) {
      const rawHref = decodeHtmlEntities(hrefM[1]);
      nextPageUrl = rawHref.startsWith("http")
        ? rawHref
        : `${origin}${rawHref.startsWith("/") ? "" : "/"}${rawHref}`;
      break;
    }
  }

  return {
    blocked: false,
    items,
    nextPageUrl,
    totalHint,
  };
}

/**
 * Parse an individual Prime Video detail page (/gp/video/detail/{ASIN}) to extract
 * exact expiration countdown/date, better title/poster/overview, and Prime inclusion status.
 */
export function parseDetailPageHtml(html, nowMs = Date.now()) {
  if (detectCaptchaOrBlock(html)) {
    return { blocked: true };
  }

  let expiry = null;

  // Layer 1: Look inside Amazon Prime Video embedded JSON payloads (<script type="text/template"> or JSON strings)
  const jsonTextPatterns = [
    /"(?:timeRemaining|leavingSoon|expirationMessage|message|text)"\s*:\s*"([^"]{2,120}(?:終了|プライム|Leaves Prime)[^"]{0,80})"/gi,
    /Primeでの配信は\d+\s*(?:日|時間)以内に終了/g,
    /\d+\s*(?:日|時間)以内にプライム会員特典ではなくな[^\n"<>]{0,20}/g,
  ];
  for (const re of jsonTextPatterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const candidate = decodeHtmlEntities(m[1] || m[0]);
      const parsed = parseExpiryText(candidate, nowMs);
      if (parsed && (parsed.daysLeft !== null || parsed.hoursLeft !== null)) {
        expiry = parsed;
        break;
      }
    }
    if (expiry) break;
  }

  // Layer 1b: Explicit epoch timestamp in entitlement/leaving JSON fields if present
  if (!expiry) {
    const epochMatch = html.match(
      /"(?:entitlementEndDate|expirationDate|leavingDate|offerEndDate|availabilityEndDate)"\s*:\s*(\d{10,13})/i
    );
    if (epochMatch) {
      const rawNum = Number.parseInt(epochMatch[1], 10);
      const targetMs = rawNum > 1e12 ? rawNum : rawNum * 1000;
      const daysLeft = Math.round(
        (jstStartOfDayUtcMs(targetMs) - jstStartOfDayUtcMs(nowMs)) / 86400000
      );
      if (daysLeft >= -1 && daysLeft <= 45) {
        const fmt = formatJstDate(targetMs);
        expiry = {
          daysLeft: Math.max(0, daysLeft),
          hoursLeft: null,
          expiresOn: Math.floor(targetMs / 1000),
          expiresDate: fmt.expiresDate,
          expiresDateLabel: fmt.expiresDateLabel,
          rawExpiryText: `${fmt.expiresDateLabel} まで`,
        };
      }
    }
  }

  // Layer 2: Stripped visible page text fallback
  const visibleText = stripTags(html);
  if (!expiry) {
    expiry = parseExpiryText(visibleText, nowMs);
  }

  // Extract metadata (title, poster, overview) if available
  const ogTitleM = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  let title = ogTitleM ? decodeHtmlEntities(ogTitleM[1]) : "";
  title = title.replace(/\s*(?:を観る|を見る)?\s*\|\s*Prime Video$/i, "").replace(/^Amazon\.co\.jp:\s*/i, "").trim();

  const ogImgM = html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  const posterUrl = ogImgM ? decodeHtmlEntities(ogImgM[1]) : "";

  const ogDescM = html.match(/<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const overview = ogDescM ? decodeHtmlEntities(ogDescM[1]) : "";

  const hasPrimeBadge =
    /プライム会員特典|Included with Prime|Primeで視聴|プライム会員は追加料金なし/i.test(visibleText) ||
    /"isPrime"\s*:\s*true/i.test(html);

  return {
    blocked: false,
    title,
    posterUrl,
    overview,
    hasPrimeBadge,
    showType: inferShowTypeFromDetailHtml(html, title),
    expiresOn: expiry ? expiry.expiresOn : null,
    expiresDate: expiry ? expiry.expiresDate : null,
    expiresDateLabel: expiry ? expiry.expiresDateLabel : "30日以内（日付未表示）",
    daysLeft: expiry ? expiry.daysLeft : null,
    hoursLeft: expiry ? expiry.hoursLeft : null,
    rawExpiryText: expiry ? expiry.rawExpiryText : "",
  };
}

/**
 * Extract watchlist titles from Amazon Prime Video Watchlist HTML (embedded JSON + links).
 */
export function parseWatchlistHtml(html) {
  if (detectCaptchaOrBlock(html)) {
    return { blocked: true, titles: [] };
  }

  const titles = [];
  const seen = new Set();
  const push = (raw) => {
    const t = decodeHtmlEntities(raw)
      .replace(/\s*(?:を観る|を見る)?\s*\|\s*Prime Video$/i, "")
      .trim();
    if (!t || t.length < 2 || t.length > 140) return;
    if (/^(再生|詳細|ウォッチリスト|削除|Prime|プライム|すべて見る|Amazon|ホーム|映画|テレビ番組)$/i.test(t)) {
      return;
    }
    const norm = normalizeTitle(t);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      titles.push(t);
    }
  };

  // Embedded Prime Video template JSON titles inside watchlist collections
  const jsonTitleRe = /"title"\s*:\s*"([^"\\]{2,120})"\s*,\s*"(?:titleId|gti|link|entityType|catalog)"/g;
  let m;
  while ((m = jsonTitleRe.exec(html)) !== null) {
    push(m[1]);
  }

  // Fallback: links to /detail/ with aria-label or img alt
  const linkRe = /<a\b[^>]*href=["'][^"']*\/(?:gp\/video\/detail|detail)\/[A-Z0-9]{10}[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const aria = m[0].match(/aria-label=["']([^"']+)["']/i);
    if (aria) {
      push(aria[1]);
      continue;
    }
    const alt = m[1].match(/\balt=["']([^"']+)["']/i);
    if (alt) {
      push(alt[1]);
      continue;
    }
    const text = stripTags(m[1]);
    if (text) push(text);
  }

  return { blocked: false, titles };
}
