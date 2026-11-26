"""Main entry point: fetch expiring Prime Video JP titles, enrich, save JSON, and notify."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Allow running directly as `python scripts/fetch_expiring.py`
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.notifier import (
    AMAZON_LEAVING_SOON_URL,
    select_notification_items,
    send_discord_notification,
    send_email_notification,
    update_history,
)
from scripts.streaming_api import (
    StreamingAvailabilityClient,
    contains_japanese,
    normalize_expiring_records,
    resolve_api_config,
)
from scripts.tmdb_client import TmdbClient
from scripts.watchlist import load_watchlist, match_watchlist

JST = timezone(timedelta(hours=9))
WEEKDAYS_JA = ("月", "火", "水", "木", "金", "土", "日")

DATA_DIR = ROOT_DIR / "docs" / "data"
EXPIRING_JSON_PATH = DATA_DIR / "expiring.json"
HISTORY_JSON_PATH = DATA_DIR / "history.json"
TMDB_CACHE_PATH = DATA_DIR / "tmdb_cache.json"
WATCHLIST_PATH = ROOT_DIR / "config" / "watchlist.txt"


def format_expiry_fields(
    expires_on: int | None,
    now_jst: datetime,
) -> dict[str, Any]:
    """Compute JST formatted date fields and remaining day count."""
    if expires_on is None:
        return {
            "expiresAt": None,
            "expiresDate": None,
            "expiresDateLabel": "30日以内（日付未確定）",
            "daysLeft": None,
        }

    dt_jst = datetime.fromtimestamp(expires_on, tz=timezone.utc).astimezone(JST)
    weekday = WEEKDAYS_JA[dt_jst.weekday()]
    days_left = (dt_jst.date() - now_jst.date()).days

    return {
        "expiresAt": dt_jst.isoformat(),
        "expiresDate": dt_jst.strftime("%Y-%m-%d"),
        "expiresDateLabel": f"{dt_jst.month}/{dt_jst.day} ({weekday})",
        "daysLeft": days_left,
    }


def enrich_and_sort_items(
    raw_items: list[dict[str, Any]],
    watchlist_entries: list[str],
    tmdb_client: TmdbClient | None = None,
    now_jst: datetime | None = None,
) -> list[dict[str, Any]]:
    """Apply TMDB Japanese metadata, JST dates, watchlist match, and sort soonest-first."""
    now = now_jst or datetime.now(JST)
    enriched: list[dict[str, Any]] = []

    for item in raw_items:
        record = dict(item)
        expiry_meta = format_expiry_fields(record.get("expiresOn"), now)

        # Skip items that already expired before today (JST)
        if expiry_meta["daysLeft"] is not None and expiry_meta["daysLeft"] < 0:
            continue
        record.update(expiry_meta)

        # Optional TMDB enrichment for Japanese title, overview, and localized poster
        if tmdb_client and tmdb_client.enabled:
            meta = tmdb_client.get_japanese_metadata(
                record.get("tmdbId"), record.get("showType")
            )
            if meta:
                if meta.get("titleJa"):
                    record["titleJa"] = meta["titleJa"]
                if meta.get("overviewJa"):
                    record["overviewJa"] = meta["overviewJa"]
                # Prefer TMDB poster (Japanese localized & avoids Streaming API 1GB CDN limit)
                if meta.get("posterJa"):
                    record["posterUrl"] = meta["posterJa"]
                if meta.get("backdropJa"):
                    record["backdropUrl"] = meta["backdropJa"]

        # Choose best display title: TMDB Japanese -> Japanese originalTitle -> English title
        display_title = (
            record.get("titleJa")
            or (record.get("originalTitle") if contains_japanese(record.get("originalTitle")) else "")
            or record.get("title")
            or ""
        )
        record["displayTitle"] = display_title
        record["displayOverview"] = record.get("overviewJa") or record.get("overview") or ""

        matched = match_watchlist(
            [
                record.get("displayTitle", ""),
                record.get("titleJa", ""),
                record.get("title", ""),
                record.get("originalTitle", ""),
            ],
            watchlist_entries,
        )
        record["inWatchlist"] = matched is not None
        record["matchedWatchlistEntry"] = matched or ""
        enriched.append(record)

    # Sort: soonest known expiration first, then undated items, then rating desc, then title
    enriched.sort(
        key=lambda x: (
            x["expiresOn"] is None,
            x["expiresOn"] if x["expiresOn"] is not None else 10**18,
            -(x.get("rating") or 0),
            x.get("displayTitle", ""),
        )
    )
    return enriched


def build_output_document(
    items: list[dict[str, Any]],
    now_jst: datetime,
    *,
    is_demo: bool = False,
    country: str = "jp",
    catalog: str = "prime.subscription",
    provider: str = "",
    tmdb_enabled: bool = False,
    repo_watchlist_count: int = 0,
) -> dict[str, Any]:
    """Construct the JSON payload consumed by docs/index.html."""
    return {
        "updatedAt": now_jst.isoformat(),
        "updatedAtLabel": now_jst.strftime("%Y/%m/%d %H:%M JST"),
        "isDemo": is_demo,
        "country": country,
        "catalog": catalog,
        "provider": provider,
        "tmdbEnabled": tmdb_enabled,
        "repoWatchlistCount": repo_watchlist_count,
        "amazonLeavingSoonUrl": AMAZON_LEAVING_SOON_URL,
        "totalCount": len(items),
        "watchlistCount": sum(1 for it in items if it.get("inWatchlist")),
        "urgentCount": sum(
            1 for it in items if it.get("daysLeft") is not None and it["daysLeft"] <= 7
        ),
        "items": items,
    }


def _load_json_safe(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> int:
    country = os.environ.get("STREAMING_COUNTRY", "jp").strip() or "jp"
    catalogs = os.environ.get("STREAMING_CATALOGS", "prime.subscription").strip() or "prime.subscription"
    max_pages = int(os.environ.get("MAX_API_PAGES", "25"))
    include_unknown_dates = os.environ.get("INCLUDE_UNKNOWN_DATES", "true").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    include_seasons = os.environ.get("INCLUDE_SEASONS", "true").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    urgent_days = int(os.environ.get("URGENT_DAYS", "3"))
    force_notify = os.environ.get("FORCE_NOTIFY", "").strip().lower() in ("1", "true", "yes")
    pages_url = os.environ.get("PAGES_URL", "").strip()

    api_config = resolve_api_config(
        direct_api_key=os.environ.get("STREAMING_AVAILABILITY_API_KEY"),
        rapidapi_key=os.environ.get("RAPIDAPI_KEY"),
        base_url_override=os.environ.get("STREAMING_API_BASE_URL"),
    )
    if api_config is None:
        print(
            "ERROR: APIキーが設定されていません。\n"
            "STREAMING_AVAILABILITY_API_KEY（Movie of the Night公式）または "
            "RAPIDAPI_KEY（RapidAPI）を環境変数/GitHub Secretsに設定してください。",
            file=sys.stderr,
        )
        return 1

    now_jst = datetime.now(JST)
    watchlist_entries = load_watchlist(WATCHLIST_PATH)
    print(
        f"[info] Fetching expiring titles from {api_config.provider_name} "
        f"({country}/{catalogs}, include_unknown_dates={include_unknown_dates}, "
        f"include_seasons={include_seasons})..."
    )

    client = StreamingAvailabilityClient(api_config)
    changes, shows_map, show_pages = client.fetch_expiring_changes(
        country=country,
        catalogs=catalogs,
        max_pages=max_pages,
        item_type="show",
        include_unknown_dates=include_unknown_dates,
    )
    print(f"[info] Fetched {len(changes)} show change records across {show_pages} page(s).")

    if include_seasons:
        season_changes, season_shows, season_pages = client.fetch_expiring_changes(
            country=country,
            catalogs=catalogs,
            max_pages=max_pages,
            item_type="season",
            include_unknown_dates=include_unknown_dates,
        )
        changes.extend(season_changes)
        for sid, sdata in season_shows.items():
            shows_map.setdefault(sid, sdata)
        print(
            f"[info] Fetched {len(season_changes)} season change records across "
            f"{season_pages} page(s)."
        )

    raw_items = normalize_expiring_records(changes, shows_map, country=country)

    tmdb_client = TmdbClient(
        api_key=os.environ.get("TMDB_API_KEY"),
        cache_path=TMDB_CACHE_PATH,
    )
    items = enrich_and_sort_items(
        raw_items,
        watchlist_entries=watchlist_entries,
        tmdb_client=tmdb_client,
        now_jst=now_jst,
    )
    tmdb_client.save_cache()

    document = build_output_document(
        items,
        now_jst,
        is_demo=False,
        country=country,
        catalog=catalogs,
        provider=api_config.provider_name,
        tmdb_enabled=tmdb_client.enabled,
        repo_watchlist_count=len(watchlist_entries),
    )

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    EXPIRING_JSON_PATH.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"[info] Saved {len(items)} items (watchlist matches: {document['watchlistCount']}) "
        f"to {EXPIRING_JSON_PATH}."
    )

    prev_history = _load_json_safe(HISTORY_JSON_PATH)
    selection = select_notification_items(
        items,
        previous_history=prev_history,
        urgent_days=urgent_days,
        force_notify=force_notify,
    )

    has_alerts = any(selection.values())
    print(
        f"[info] Notification candidates -> watchlist: {len(selection['watchlist'])}, "
        f"new: {len(selection['new'])}, urgent: {len(selection['urgent'])}"
    )

    if has_alerts:
        discord_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
        if discord_url:
            sent = send_discord_notification(
                discord_url,
                selection,
                total_count=len(items),
                pages_url=pages_url,
            )
            print(f"[info] Sent {sent} Discord message(s).")

        smtp_host = os.environ.get("SMTP_HOST", "").strip()
        smtp_user = os.environ.get("SMTP_USER", "").strip()
        smtp_pass = os.environ.get("SMTP_PASS", "").strip()
        mail_to = os.environ.get("MAIL_TO", "").strip()
        if smtp_host and smtp_user and smtp_pass and mail_to:
            smtp_port = int(os.environ.get("SMTP_PORT", "587"))
            mail_from = os.environ.get("MAIL_FROM", "").strip()
            send_email_notification(
                smtp_host=smtp_host,
                smtp_port=smtp_port,
                smtp_user=smtp_user,
                smtp_pass=smtp_pass,
                mail_to=mail_to,
                selection=selection,
                total_count=len(items),
                mail_from=mail_from,
                pages_url=pages_url,
            )
            print(f"[info] Sent email notification to {mail_to}.")
    else:
        print("[info] No new or urgent changes to notify today.")

    next_history = update_history(
        items,
        previous_history=prev_history,
        urgent_days=urgent_days,
        updated_at=now_jst.isoformat(),
    )
    HISTORY_JSON_PATH.write_text(
        json.dumps(next_history, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
