import test from "node:test";
import assert from "node:assert/strict";

import {
  detectCaptchaOrBlock,
  matchWatchlist,
  normalizeTitle,
  parseDetailPageHtml,
  parseExpiryText,
  parseSearchPageHtml,
  parseWatchlistHtml,
} from "../extension/lib/amazon-parser.js";

// Fixed reference time: 2026-11-26 16:00:00 JST (= 07:00:00 UTC)
const NOW_MS = Date.UTC(2026, 10, 26, 7, 0, 0);

test("parseExpiryText parses Japanese days, hours, dates, and ignores generic 30-day heading", () => {
  const d5 = parseExpiryText("Primeでの配信は5日以内に終了", NOW_MS);
  assert.equal(d5.daysLeft, 5);
  assert.equal(d5.expiresDate, "2026-12-01");

  const d14 = parseExpiryText("30日以内にプライム会員特典ではなくなる作品 ... Primeでの配信は14日以内に終了", NOW_MS);
  assert.equal(d14.daysLeft, 14);
  assert.equal(d14.expiresDate, "2026-12-10");

  const h18 = parseExpiryText("Primeでの配信は18時間以内に終了", NOW_MS);
  assert.equal(h18.hoursLeft, 18);
  assert.equal(h18.daysLeft, 1);

  const md = parseExpiryText("プライム会員特典は12月5日まで", NOW_MS);
  assert.equal(md.expiresDate, "2026-12-05");
  assert.equal(md.daysLeft, 9);

  const en = parseExpiryText("Leaves Prime in 3 days", NOW_MS);
  assert.equal(en.daysLeft, 3);
  assert.equal(en.expiresDate, "2026-11-29");
});

test("parseSearchPageHtml extracts titles, upgraded posters, totalHint, and pagination", () => {
  const html = `
    <html><body>
      <div>検索結果 198 のうち 1-16件</div>
      <div data-asin="B00KILLER1" data-component-type="s-search-result">
        <img class="s-image" src="https://m.media-amazon.com/images/I/killer._AC_UY218_.jpg" alt="キラークラウン (字幕版)" />
        <h2><a href="/gp/video/detail/B00KILLER1/ref=sr_1_1"><span>キラークラウン (字幕版)</span></a></h2>
        <span>1988</span>
        <span>Primeでの配信は5日以内に終了</span>
      </div>
      <div data-asin="B00OSIRIS2" data-component-type="s-search-result">
        <img class="s-image" src="https://m.media-amazon.com/images/I/osiris._AC_UL320_.jpg" alt="OSIRIS／オシリス" />
        <h2><a href="/dp/B00OSIRIS2"><span>OSIRIS／オシリス</span></a></h2>
      </div>
      <a class="s-pagination-item s-pagination-next" href="/s?rh=n%3A4217521051&amp;page=2">次へ</a>
    </body></html>
  `;

  const res = parseSearchPageHtml(html, "https://www.amazon.co.jp/s?rh=n%3A4217521051", NOW_MS);
  assert.equal(res.blocked, false);
  assert.equal(res.totalHint, 198);
  assert.equal(res.nextPageUrl, "https://www.amazon.co.jp/s?rh=n%3A4217521051&page=2");
  assert.equal(res.items.length, 2);

  assert.equal(res.items[0].asin, "B00KILLER1");
  assert.equal(res.items[0].displayTitle, "キラークラウン (字幕版)");
  assert.equal(res.items[0].posterUrl, "https://m.media-amazon.com/images/I/killer._AC_UL480_.jpg");
  assert.equal(res.items[0].primeLink, "https://www.amazon.co.jp/gp/video/detail/B00KILLER1");
  assert.equal(res.items[0].daysLeft, 5);
  assert.equal(res.items[0].expiresDate, "2026-12-01");

  assert.equal(res.items[1].asin, "B00OSIRIS2");
  assert.equal(res.items[1].daysLeft, null);
});

test("parseDetailPageHtml extracts exact expiry from embedded JSON, ignores nav TV text, and handles CAPTCHA", () => {
  const detailHtml = `
    <html>
      <head>
        <meta property="og:title" content="OSIRIS／オシリスを観る | Prime Video" />
        <meta property="og:description" content="米軍特殊部隊が謎の宇宙船に拉致されるSFアクション。" />
      </head>
      <body>
        <nav>ホーム 映画 TV番組 シリーズ</nav>
        <script type="text/template">
          {"titleType":"MOVIE","entitlementCues":{"timeRemaining":"Primeでの配信は14日以内に終了"}}
        </script>
      </body>
    </html>
  `;
  const detail = parseDetailPageHtml(detailHtml, NOW_MS);
  assert.equal(detail.blocked, false);
  assert.equal(detail.title, "OSIRIS／オシリス");
  assert.equal(detail.showType, "movie");
  assert.equal(detail.daysLeft, 14);
  assert.equal(detail.expiresDate, "2026-12-10");
  assert.match(detail.overview, /SFアクション/);

  const seriesHtml = `<html><body><script type="text/template">{"titleType":"SEASON"}</script></body></html>`;
  assert.equal(parseDetailPageHtml(seriesHtml, NOW_MS).showType, "series");

  const captchaHtml = `<html><form action="/errors/validateCaptcha"><input id="captchacharacters" /></form></html>`;
  assert.equal(detectCaptchaOrBlock(captchaHtml), true);
  assert.equal(parseDetailPageHtml(captchaHtml, NOW_MS).blocked, true);
});

test("parseWatchlistHtml and matchWatchlist match normalized Japanese titles", () => {
  const html = `
    <script type="text/template">
      {"title":"キラークラウン","titleId":"B00KILLER1"}
      {"title":"ＯＳＩＲＩＳ／オシリス","titleId":"B00OSIRIS2"}
    </script>
  `;
  const wl = parseWatchlistHtml(html);
  assert.equal(wl.blocked, false);
  assert.deepEqual(wl.titles, ["キラークラウン", "ＯＳＩＲＩＳ／オシリス"]);

  assert.equal(normalizeTitle("キラークラウン (字幕版)"), "キラークラウン");
  assert.equal(matchWatchlist(["キラークラウン (字幕版)"], wl.titles), "キラークラウン");
  assert.equal(matchWatchlist(["OSIRIS／オシリス"], wl.titles), "ＯＳＩＲＩＳ／オシリス");
});
