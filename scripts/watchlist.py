"""Watchlist loading and fuzzy title matching utilities."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Iterable

# Common decorative punctuation / whitespace removed during normalization
_STRIP_PATTERN = re.compile(
    r"[\s\u3000\-‐‑‒–—―~〜～:：;；!！?？.,。、・･'’\"“”()（）\[\]【】「」『』/／\\|_]+"
)

# Common trailing season / edition labels often present in Amazon Prime Video titles
_SUFFIX_PATTERN = re.compile(
    r"(?:\s*(?:シーズン|season|part|パート|第)\s*\d+.*|"
    r"\s*\((?:字幕版|吹替版|吹き替え版|日本語吹替版|4k|uhd|hd)\)|"
    r"\s*（(?:字幕版|吹替版|吹き替え版|日本語吹替版|4k|uhd|hd)）)$",
    re.IGNORECASE,
)


def normalize_title(text: str) -> str:
    """Normalize Japanese/English title for resilient comparison."""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text).strip().lower()
    # Strip trailing season/audio suffixes before stripping punctuation
    s = _SUFFIX_PATTERN.sub("", s).strip()
    s = _STRIP_PATTERN.sub("", s)
    return s


def load_watchlist(path: Path | str) -> list[str]:
    """Load non-empty, non-comment title entries from watchlist.txt."""
    file_path = Path(path)
    if not file_path.exists():
        return []

    entries: list[str] = []
    seen: set[str] = set()
    for raw_line in file_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        norm = normalize_title(line)
        if norm and norm not in seen:
            seen.add(norm)
            entries.append(line)
    return entries


def match_watchlist(
    candidate_titles: Iterable[str],
    watchlist_entries: Iterable[str],
) -> str | None:
    """Return the first matching watchlist entry, or None if no match.

    Matches exact normalized strings first; for queries of length >= 3, also
    allows substring matching so e.g. 'Interstellar' or 'インターステラー'
    matches decorated Amazon titles like 'インターステラー (字幕版)'.
    """
    norm_candidates = [
        normalize_title(t) for t in candidate_titles if t and normalize_title(t)
    ]
    if not norm_candidates:
        return None

    for entry in watchlist_entries:
        norm_entry = normalize_title(entry)
        if not norm_entry:
            continue
        for cand in norm_candidates:
            if norm_entry == cand:
                return entry
            if len(norm_entry) >= 3 and (norm_entry in cand or cand in norm_entry):
                return entry
    return None
