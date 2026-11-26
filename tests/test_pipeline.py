"""Unit tests for the Prime Video Expiring Tracker pipeline."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.fetch_expiring import JST, enrich_and_sort_items, format_expiry_fields
from scripts.generate_sample_data import generate_sample_data
from scripts.notifier import (
    build_discord_payloads,
    build_email_html,
    select_notification_items,
    update_history,
)
from scripts.streaming_api import (
    StreamingAvailabilityClient,
    normalize_expiring_records,
    resolve_api_config,
)
from scripts.tmdb_client import TmdbClient, parse_tmdb_id
from scripts.watchlist import load_watchlist, match_watchlist, normalize_title


class WatchlistTests(unittest.TestCase):
    def test_normalize_strips_width_punctuation_and_season_suffix(self) -> None:
        self.assertEqual(normalize_title("インターステラー (字幕版)"), "インターステラー")
        self.assertEqual(normalize_title("Ｄｒ．ＳＴＯＮＥ シーズン2"), "drstone")
        self.assertEqual(normalize_title("Blade Runner: 2049"), "bladerunner2049")

    def test_match_watchlist_handles_japanese_and_english(self) -> None:
        wl = ["インターステラー", "呪術廻戦", "Blade Runner 2049"]
        self.assertEqual(
            match_watchlist(["インターステラー（吹替版）", "Interstellar"], wl),
            "インターステラー",
        )
        self.assertEqual(
            match_watchlist(["ブレードランナー 2049", "Blade Runner 2049"], wl),
            "Blade Runner 2049",
        )
        self.assertIsNone(match_watchlist(["全く別の映画", "Unrelated"], wl))

    def test_load_watchlist_skips_comments_and_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "watchlist.txt"
            p.write_text(
                "# comment\n\nインターステラー\nインターステラー (字幕版)\n呪術廻戦\n",
                encoding="utf-8",
            )
            entries = load_watchlist(p)
            self.assertEqual(entries, ["インターステラー", "呪術廻戦"])


class StreamingApiTests(unittest.TestCase):
    def test_resolve_api_config_direct_and_rapidapi(self) -> None:
        direct = resolve_api_config(direct_api_key="abc123")
        assert direct is not None
        self.assertEqual(direct.provider_name, "movieofthenight")
        self.assertEqual(direct.headers["X-API-Key"], "abc123")

        rapid = resolve_api_config(rapidapi_key="rkey")
        assert rapid is not None
        self.assertEqual(rapid.provider_name, "rapidapi")
        self.assertEqual(rapid.headers["X-RapidAPI-Key"], "rkey")

        self.assertIsNone(resolve_api_config())

    def test_normalize_deduplicates_and_extracts_posters_and_links(self) -> None:
        changes = [
            {
                "changeType": "expiring",
                "itemType": "show",
                "showId": "100",
                "showType": "movie",
                "streamingOptionType": "subscription",
                "timestamp": 1800000500,
                "link": "https://www.amazon.co.jp/gp/video/detail/B00EXAMPLE",
            },
            # Duplicate showId with earlier timestamp should win
            {
                "changeType": "expiring",
                "itemType": "show",
                "showId": "100",
                "showType": "movie",
                "streamingOptionType": "subscription",
                "timestamp": 1800000100,
                "link": "https://www.amazon.co.jp/gp/video/detail/B00EXAMPLE",
            },
            # Non-subscription option should be ignored
            {
                "changeType": "expiring",
                "itemType": "show",
                "showId": "200",
                "showType": "movie",
                "streamingOptionType": "rent",
                "timestamp": 1800000200,
            },
            # Japanese anime without explicit link falls back to Prime search
            {
                "changeType": "expiring",
                "itemType": "show",
                "showId": "300",
                "showType": "series",
                "streamingOptionType": "sub",
                "timestamp": None,
            },
        ]
        shows_map = {
            "100": {
                "id": "100",
                "tmdbId": "movie/157336",
                "title": "Interstellar",
                "originalTitle": "Interstellar",
                "showType": "movie",
                "releaseYear": 2014,
                "rating": 87,
                "genres": [{"id": "scifi", "name": "Science Fiction"}],
                "imageSet": {
                    "verticalPoster": {"w240": "https://cdn.example/240.jpg", "w360": "https://cdn.example/360.jpg"},
                    "horizontalPoster": {"w480": "https://cdn.example/h480.jpg"},
                },
            },
            "300": {
                "id": "300",
                "tmdbId": "tv/95479",
                "title": "Jujutsu Kaisen",
                "originalTitle": "呪術廻戦",
                "showType": "series",
                "firstAirYear": 2020,
                "seasonCount": 2,
            },
        }
        items = normalize_expiring_records(changes, shows_map, country="jp")
        self.assertEqual(len(items), 2)

        by_id = {x["id"]: x for x in items}
        self.assertEqual(by_id["100"]["expiresOn"], 1800000100)
        self.assertEqual(by_id["100"]["posterUrl"], "https://cdn.example/360.jpg")
        self.assertEqual(by_id["100"]["primeLink"], "https://www.amazon.co.jp/gp/video/detail/B00EXAMPLE")

        self.assertEqual(by_id["300"]["titleJa"], "呪術廻戦")
        self.assertIn("amazon.co.jp/s?", by_id["300"]["primeLink"])

    def test_pagination_follows_next_cursor(self) -> None:
        cfg = resolve_api_config(direct_api_key="testkey")
        assert cfg is not None
        client = StreamingAvailabilityClient(cfg)

        page1 = {
            "changes": [{"showId": "1", "streamingOptionType": "subscription"}],
            "shows": {"1": {"id": "1", "title": "First"}},
            "hasMore": True,
            "nextCursor": "cursor-2",
        }
        page2 = {
            "changes": [{"showId": "2", "streamingOptionType": "subscription"}],
            "shows": {"2": {"id": "2", "title": "Second"}},
            "hasMore": False,
        }

        with patch.object(client, "_get_json", side_effect=[page1, page2]) as mock_get:
            changes, shows, pages = client.fetch_expiring_changes(max_pages=5)
            self.assertEqual(pages, 2)
            self.assertEqual(len(changes), 2)
            self.assertEqual(set(shows.keys()), {"1", "2"})
            self.assertEqual(mock_get.call_count, 2)
            self.assertEqual(mock_get.call_args_list[1][0][1]["cursor"], "cursor-2")


class TmdbAndEnrichTests(unittest.TestCase):
    def test_parse_tmdb_id(self) -> None:
        self.assertEqual(parse_tmdb_id("movie/238"), ("movie", "238"))
        self.assertEqual(parse_tmdb_id("tv/1399"), ("tv", "1399"))
        self.assertEqual(parse_tmdb_id("series/1399"), ("tv", "1399"))
        self.assertIsNone(parse_tmdb_id("invalid"))

    def test_enrich_applies_tmdb_localization_filters_expired_and_sorts(self) -> None:
        now = datetime(2026, 11, 26, 7, 0, tzinfo=JST)
        ts_past = int((now - timedelta(days=2)).astimezone(timezone.utc).timestamp())
        ts_2d = int((now + timedelta(days=2)).astimezone(timezone.utc).timestamp())
        ts_10d = int((now + timedelta(days=10)).astimezone(timezone.utc).timestamp())

        raw_items = [
            {
                "id": "expired",
                "tmdbId": "movie/1",
                "title": "Already Gone",
                "originalTitle": "Already Gone",
                "titleJa": "",
                "showType": "movie",
                "posterUrl": "",
                "primeLink": "https://example.com/expired",
                "expiresOn": ts_past,
            },
            {
                "id": "later",
                "tmdbId": "movie/2",
                "title": "Later Film",
                "originalTitle": "Later Film",
                "titleJa": "",
                "showType": "movie",
                "posterUrl": "https://cdn.example/orig.jpg",
                "primeLink": "https://example.com/later",
                "expiresOn": ts_10d,
            },
            {
                "id": "sooner",
                "tmdbId": "movie/157336",
                "title": "Interstellar",
                "originalTitle": "Interstellar",
                "titleJa": "",
                "showType": "movie",
                "posterUrl": "https://cdn.example/en.jpg",
                "primeLink": "https://example.com/sooner",
                "expiresOn": ts_2d,
            },
            {
                "id": "undated",
                "tmdbId": "",
                "title": "Undated Anime",
                "originalTitle": "未確定アニメ",
                "titleJa": "未確定アニメ",
                "showType": "series",
                "posterUrl": "",
                "primeLink": "https://example.com/undated",
                "expiresOn": None,
            },
        ]

        mock_tmdb = MagicMock(spec=TmdbClient)
        mock_tmdb.enabled = True
        mock_tmdb.get_japanese_metadata.side_effect = lambda tid, st: (
            {
                "titleJa": "インターステラー",
                "overviewJa": "日本語あらすじ",
                "posterJa": "https://image.tmdb.org/t/p/w342/ja.jpg",
                "backdropJa": "",
            }
            if tid == "movie/157336"
            else None
        )

        result = enrich_and_sort_items(
            raw_items,
            watchlist_entries=["インターステラー"],
            tmdb_client=mock_tmdb,
            now_jst=now,
        )
        self.assertEqual([r["id"] for r in result], ["sooner", "later", "undated"])
        self.assertEqual(result[0]["displayTitle"], "インターステラー")
        self.assertEqual(result[0]["posterUrl"], "https://image.tmdb.org/t/p/w342/ja.jpg")
        self.assertTrue(result[0]["inWatchlist"])
        self.assertEqual(result[0]["daysLeft"], 2)
        self.assertIsNone(result[2]["daysLeft"])


class NotificationTests(unittest.TestCase):
    def test_selection_history_and_payload_builders(self) -> None:
        items = [
            {
                "id": "wl-1",
                "displayTitle": "インターステラー",
                "showType": "movie",
                "daysLeft": 2,
                "expiresDate": "2026-11-28",
                "expiresDateLabel": "11/28 (土)",
                "primeLink": "https://www.amazon.co.jp/gp/video/detail/B00TEST1",
                "posterUrl": "https://image.tmdb.org/t/p/w342/poster1.jpg",
                "inWatchlist": True,
            },
            {
                "id": "new-1",
                "displayTitle": "メッセージ",
                "showType": "movie",
                "daysLeft": 14,
                "expiresDate": "2026-12-10",
                "expiresDateLabel": "12/10 (木)",
                "primeLink": "https://www.amazon.co.jp/gp/video/detail/B00TEST2",
                "posterUrl": "https://image.tmdb.org/t/p/w342/poster2.jpg",
                "inWatchlist": False,
            },
        ]

        # First run: both items should be notified
        sel1 = select_notification_items(items, previous_history={})
        self.assertEqual([x["id"] for x in sel1["watchlist"]], ["wl-1"])
        self.assertEqual([x["id"] for x in sel1["new"]], ["new-1"])

        discord_payloads = build_discord_payloads(
            sel1, total_count=2, pages_url="https://user.github.io/repo/"
        )
        self.assertEqual(len(discord_payloads), 1)
        self.assertIn("インターステラー", discord_payloads[0]["embeds"][0]["description"])
        self.assertIn("https://user.github.io/repo/", discord_payloads[0]["content"])

        subject, html_body = build_email_html(
            sel1, total_count=2, pages_url="https://user.github.io/repo/"
        )
        self.assertIn("★ウォッチリスト1件", subject)
        self.assertIn("https://image.tmdb.org/t/p/w342/poster1.jpg", html_body)
        self.assertIn("4217521051", html_body)

        # Second run with same items: no duplicate notification
        hist = update_history(items, previous_history={}, updated_at="2026-11-26T07:00:00+09:00")
        sel2 = select_notification_items(items, previous_history=hist)
        self.assertEqual(sel2["watchlist"], [])
        self.assertEqual(sel2["new"], [])
        self.assertEqual(sel2["urgent"], [])

        # Next day when watchlist item hits 1 day left: milestone triggers reminder
        items_next_day = [dict(items[0], daysLeft=1), items[1]]
        sel3 = select_notification_items(items_next_day, previous_history=hist)
        self.assertEqual([x["id"] for x in sel3["watchlist"]], ["wl-1"])

    def test_generate_sample_data_writes_valid_json(self) -> None:
        out_path = generate_sample_data()
        data = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertTrue(data["isDemo"])
        self.assertGreaterEqual(len(data["items"]), 5)
        self.assertTrue(all(it.get("posterUrl") for it in data["items"]))


if __name__ == "__main__":
    unittest.main()
