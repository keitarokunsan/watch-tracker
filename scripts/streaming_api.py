"""Client for Movie of the Night / RapidAPI Streaming Availability API."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

DIRECT_BASE_URL = "https://api.movieofthenight.com/v4"
RAPIDAPI_BASE_URL = "https://streaming-availability.p.rapidapi.com"
RAPIDAPI_HOST = "streaming-availability.p.rapidapi.com"
AMAZON_LEAVING_SOON_URL = "https://www.amazon.co.jp/s?rh=n%3A4217521051"

_JAPANESE_CHAR_RE = re.compile(r"[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]")


def contains_japanese(text: str | None) -> bool:
    return bool(text and _JAPANESE_CHAR_RE.search(text))


def _pick_image(image_dict: dict[str, Any] | None, preferred_keys: tuple[str, ...]) -> str:
    if not isinstance(image_dict, dict):
        return ""
    for key in preferred_keys:
        val = image_dict.get(key)
        if isinstance(val, str) and val.startswith(("http://", "https://")):
            return val
    for val in image_dict.values():
        if isinstance(val, str) and val.startswith(("http://", "https://")):
            return val
    return ""


def _extract_prime_option(show: dict[str, Any], country: str) -> dict[str, Any] | None:
    options_by_country = show.get("streamingOptions")
    if not isinstance(options_by_country, dict):
        return None
    options = options_by_country.get(country.lower()) or options_by_country.get(country.upper())
    if not isinstance(options, list):
        return None

    # Prefer subscription option on Prime Video
    for opt in options:
        if not isinstance(opt, dict):
            continue
        service = opt.get("service") or {}
        service_id = service.get("id") if isinstance(service, dict) else str(service)
        opt_type = (opt.get("type") or "").lower()
        if service_id == "prime" and opt_type in ("subscription", "sub"):
            return opt

    for opt in options:
        if not isinstance(opt, dict):
            continue
        service = opt.get("service") or {}
        service_id = service.get("id") if isinstance(service, dict) else str(service)
        if service_id == "prime":
            return opt
    return None


@dataclass
class ApiConfig:
    base_url: str
    headers: dict[str, str]
    provider_name: str


def resolve_api_config(
    direct_api_key: str | None = None,
    rapidapi_key: str | None = None,
    base_url_override: str | None = None,
) -> ApiConfig | None:
    """Resolve endpoint URL and auth headers from provided API key(s)."""
    direct_key = (direct_api_key or "").strip()
    rapid_key = (rapidapi_key or "").strip()
    override = (base_url_override or "").strip().rstrip("/")

    if direct_key:
        return ApiConfig(
            base_url=override or DIRECT_BASE_URL,
            headers={
                "X-API-Key": direct_key,
                "Accept": "application/json",
                "User-Agent": "prime-video-expiring-tracker/1.0",
            },
            provider_name="movieofthenight",
        )

    if rapid_key:
        base = override or RAPIDAPI_BASE_URL
        parsed = urllib.parse.urlparse(base)
        return ApiConfig(
            base_url=base,
            headers={
                "X-RapidAPI-Key": rapid_key,
                "X-RapidAPI-Host": parsed.netloc or RAPIDAPI_HOST,
                "Accept": "application/json",
                "User-Agent": "prime-video-expiring-tracker/1.0",
            },
            provider_name="rapidapi",
        )

    return None


class StreamingAvailabilityClient:
    """Fetch expiring Amazon Prime Video titles via the /changes endpoint."""

    def __init__(self, config: ApiConfig, timeout: int = 20) -> None:
        self.config = config
        self.timeout = timeout

    def _get_json(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        query = urllib.parse.urlencode(params)
        url = f"{self.config.base_url.rstrip('/')}{path}?{query}"
        req = urllib.request.Request(url, headers=self.config.headers, method="GET")

        last_err: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")[:300]
                except OSError:
                    pass
                # Retry transient 429 / 5xx errors briefly
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    last_err = exc
                    continue
                raise RuntimeError(
                    f"Streaming Availability API HTTP {exc.code}: {body}"
                ) from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last_err = exc
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise RuntimeError(f"Streaming Availability API network error: {exc}") from exc

        raise RuntimeError(f"Streaming Availability API failed: {last_err}")

    def fetch_expiring_changes(
        self,
        country: str = "jp",
        catalogs: str = "prime.subscription",
        max_pages: int = 25,
        item_type: str = "show",
        include_unknown_dates: bool = True,
    ) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], int]:
        """Paginate through /changes?change_type=expiring and return (changes, shows_map, pages)."""
        all_changes: list[dict[str, Any]] = []
        shows_map: dict[str, dict[str, Any]] = {}
        cursor: str | None = None
        pages_fetched = 0

        for _ in range(max_pages):
            params: dict[str, str] = {
                "country": country,
                "catalogs": catalogs,
                "change_type": "expiring",
                "item_type": item_type,
                "include_unknown_dates": "true" if include_unknown_dates else "false",
                "order_direction": "asc",
                "output_language": "en",
            }
            if cursor:
                params["cursor"] = cursor

            payload = self._get_json("/changes", params)
            pages_fetched += 1

            page_changes = payload.get("changes") or []
            if isinstance(page_changes, list):
                all_changes.extend(page_changes)

            raw_shows = payload.get("shows") or {}
            if isinstance(raw_shows, dict):
                for sid, sdata in raw_shows.items():
                    if isinstance(sdata, dict):
                        shows_map[str(sid)] = sdata
            elif isinstance(raw_shows, list):
                for sdata in raw_shows:
                    if isinstance(sdata, dict) and sdata.get("id") is not None:
                        shows_map[str(sdata["id"])] = sdata

            has_more = bool(payload.get("hasMore"))
            next_cursor = payload.get("nextCursor")
            if not has_more or not next_cursor or next_cursor == cursor:
                break
            cursor = str(next_cursor)

        return all_changes, shows_map, pages_fetched


def normalize_expiring_records(
    changes: list[dict[str, Any]],
    shows_map: dict[str, dict[str, Any]],
    country: str = "jp",
) -> list[dict[str, Any]]:
    """Combine show/season changes + showsMap into deduplicated normalized item dicts."""
    by_show_id: dict[str, dict[str, Any]] = {}

    for change in changes:
        if not isinstance(change, dict):
            continue

        # Keep subscription removals (defensive guard if broad catalog was queried)
        opt_type = (change.get("streamingOptionType") or "").lower()
        if opt_type and opt_type not in ("subscription", "sub"):
            continue

        show_id = str(change.get("showId") or "").strip()
        if not show_id:
            continue

        item_type = str(change.get("itemType") or "show").lower()
        season_num = change.get("season")
        season_int = int(season_num) if isinstance(season_num, int) and season_num > 0 else None

        show = shows_map.get(show_id) or {}
        prime_opt = _extract_prime_option(show, country)

        ts = change.get("timestamp")
        if ts is None and item_type == "show" and prime_opt:
            ts = prime_opt.get("expiresOn")
        expires_on = int(ts) if isinstance(ts, (int, float)) and ts > 0 else None

        existing = by_show_id.get(show_id)
        if existing:
            # Prefer earliest known expiration timestamp
            prev_ts = existing.get("expiresOn")
            if prev_ts is None and expires_on is not None:
                existing["expiresOn"] = expires_on
            elif prev_ts is not None and expires_on is not None and expires_on < prev_ts:
                existing["expiresOn"] = expires_on
            if not existing.get("primeLink") and change.get("link"):
                existing["primeLink"] = str(change["link"])
            if item_type == "show":
                existing["_wholeShowExpiring"] = True
            elif season_int is not None:
                existing["_expiringSeasons"].add(season_int)
            continue

        title_en = str(show.get("title") or "").strip()
        original_title = str(show.get("originalTitle") or "").strip()
        show_type = str(show.get("showType") or change.get("showType") or "movie").lower()
        if item_type == "season":
            show_type = "series"

        image_set = show.get("imageSet") if isinstance(show.get("imageSet"), dict) else {}
        poster_url = _pick_image(
            image_set.get("verticalPoster"),
            ("w360", "w240", "w480", "w600", "w720"),
        )
        backdrop_url = _pick_image(
            image_set.get("horizontalPoster"),
            ("w480", "w720", "w360", "w1080"),
        )

        prime_link = str(
            change.get("link") or (prime_opt.get("link") if prime_opt else "") or ""
        ).strip()
        if not prime_link:
            query_title = original_title if contains_japanese(original_title) else (title_en or show_id)
            prime_link = (
                "https://www.amazon.co.jp/s?"
                + urllib.parse.urlencode({"k": query_title, "i": "instant-video"})
            )

        raw_genres = show.get("genres") or []
        genres: list[str] = []
        for g in raw_genres:
            if isinstance(g, dict) and g.get("name"):
                genres.append(str(g["name"]))
            elif isinstance(g, str) and g:
                genres.append(g)

        year = show.get("releaseYear") or show.get("firstAirYear")
        rating = show.get("rating")

        by_show_id[show_id] = {
            "id": show_id,
            "tmdbId": str(show.get("tmdbId") or ""),
            "imdbId": str(show.get("imdbId") or ""),
            "title": title_en or original_title or f"Title #{show_id}",
            "originalTitle": original_title,
            "titleJa": original_title if contains_japanese(original_title) else "",
            "showType": "series" if show_type == "series" else "movie",
            "releaseYear": int(year) if isinstance(year, int) else None,
            "rating": int(rating) if isinstance(rating, (int, float)) else None,
            "runtime": show.get("runtime") if isinstance(show.get("runtime"), int) else None,
            "seasonCount": show.get("seasonCount") if isinstance(show.get("seasonCount"), int) else None,
            "genres": genres,
            "overview": str(show.get("overview") or "").strip(),
            "overviewJa": "",
            "posterUrl": poster_url,
            "backdropUrl": backdrop_url,
            "primeLink": prime_link,
            "expiresOn": expires_on,
            "expiresSoon": True,
            "_wholeShowExpiring": item_type == "show",
            "_expiringSeasons": {season_int} if season_int is not None else set(),
        }

    results: list[dict[str, Any]] = []
    for record in by_show_id.values():
        whole_show = record.pop("_wholeShowExpiring")
        seasons_set = record.pop("_expiringSeasons")
        # Expose specific expiring seasons when only season-level changes were reported
        record["expiringSeasons"] = [] if whole_show else sorted(seasons_set)
        results.append(record)

    return results
