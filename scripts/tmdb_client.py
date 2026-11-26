"""Optional TMDB API client for Japanese titles, overviews, and localized posters."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

TMDB_API_BASE = "https://api.themoviedb.org/3"
TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w342"
TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w780"
DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days


def parse_tmdb_id(tmdb_id: str | None, show_type: str | None = None) -> tuple[str, str] | None:
    """Parse Streaming Availability tmdbId like 'movie/238' or 'tv/1399'."""
    if not tmdb_id:
        return None
    raw = str(tmdb_id).strip()
    if "/" in raw:
        media, num = raw.split("/", 1)
        media = media.lower()
        if media == "series":
            media = "tv"
        if media in ("movie", "tv") and num.isdigit():
            return media, num
    elif raw.isdigit():
        media = "tv" if show_type == "series" else "movie"
        return media, raw
    return None


class TmdbClient:
    """Fetch and cache Japanese metadata from TMDB API v3."""

    def __init__(
        self,
        api_key: str | None,
        cache_path: Path | str | None = None,
        timeout: int = 15,
        ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.cache_path = Path(cache_path) if cache_path else None
        self.timeout = timeout
        self.ttl_seconds = ttl_seconds
        self._cache: dict[str, dict[str, Any]] = {}
        self._dirty = False
        if self.cache_path and self.cache_path.exists():
            try:
                loaded = json.loads(self.cache_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self._cache = loaded
            except (OSError, json.JSONDecodeError):
                self._cache = {}

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _build_request(self, media_type: str, numeric_id: str) -> urllib.request.Request:
        params: dict[str, str] = {"language": "ja-JP"}
        headers: dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": "prime-video-expiring-tracker/1.0",
        }
        # Support both TMDB v4 Read Access Token (JWT, starts with eyJ) and v3 API key
        if self.api_key.startswith("eyJ") and len(self.api_key) > 50:
            headers["Authorization"] = f"Bearer {self.api_key}"
        else:
            params["api_key"] = self.api_key

        url = f"{TMDB_API_BASE}/{media_type}/{numeric_id}?{urllib.parse.urlencode(params)}"
        return urllib.request.Request(url, headers=headers, method="GET")

    def get_japanese_metadata(
        self,
        tmdb_id: str | None,
        show_type: str | None = None,
    ) -> dict[str, Any] | None:
        """Return localized Japanese title/overview/poster for a TMDB ID."""
        if not self.enabled:
            return None

        parsed = parse_tmdb_id(tmdb_id, show_type)
        if not parsed:
            return None

        media_type, numeric_id = parsed
        cache_key = f"{media_type}/{numeric_id}"
        now = int(time.time())

        cached = self._cache.get(cache_key)
        if cached and now - int(cached.get("fetchedAt", 0)) < self.ttl_seconds:
            return cached

        req = self._build_request(media_type, numeric_id)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            return cached

        title_ja = payload.get("title") if media_type == "movie" else payload.get("name")
        poster_path = payload.get("poster_path")
        backdrop_path = payload.get("backdrop_path")
        overview_ja = payload.get("overview") or ""

        entry = {
            "titleJa": title_ja or "",
            "overviewJa": overview_ja,
            "posterJa": f"{TMDB_POSTER_BASE}{poster_path}" if poster_path else "",
            "backdropJa": f"{TMDB_BACKDROP_BASE}{backdrop_path}" if backdrop_path else "",
            "fetchedAt": now,
        }
        self._cache[cache_key] = entry
        self._dirty = True
        return entry

    def save_cache(self) -> None:
        """Persist TMDB metadata cache to disk if modified."""
        if not self.cache_path or not self._dirty:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(
            json.dumps(self._cache, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        self._dirty = False
