"""Generate realistic offline-friendly sample expiring.json for immediate UI preview."""

from __future__ import annotations

import json
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.fetch_expiring import (
    DATA_DIR,
    EXPIRING_JSON_PATH,
    JST,
    build_output_document,
    enrich_and_sort_items,
)


def _svg_poster_data_uri(title: str, subtitle: str, bg1: str, bg2: str, accent: str) -> str:
    """Create a crisp 2:3 vertical SVG poster data URI for offline preview."""
    safe_title = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    safe_sub = subtitle.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # Wrap long title lines gently
    lines = [safe_title[i : i + 10] for i in range(0, min(len(safe_title), 30), 10)]
    tspan_svg = "".join(
        f'<tspan x="24" dy="{0 if idx == 0 else 30}">{line}</tspan>'
        for idx, line in enumerate(lines)
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 360" width="240" height="360">'
        f"<defs>"
        f'<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0%" stop-color="{bg1}"/>'
        f'<stop offset="100%" stop-color="{bg2}"/>'
        f"</linearGradient>"
        f"</defs>"
        f'<rect width="240" height="360" fill="url(#g)"/>'
        f'<circle cx="195" cy="70" r="78" fill="{accent}" opacity="0.22"/>'
        f'<circle cx="40" cy="300" r="90" fill="{accent}" opacity="0.14"/>'
        f'<rect x="20" y="22" width="84" height="22" rx="11" fill="rgba(0,0,0,0.42)"/>'
        f'<text x="62" y="37" fill="#ffffff" font-family="sans-serif" font-size="11" '
        f'font-weight="700" text-anchor="middle">SAMPLE</text>'
        f'<text x="24" y="210" fill="#ffffff" font-family="sans-serif" font-size="22" '
        f'font-weight="800">{tspan_svg}</text>'
        f'<text x="24" y="328" fill="rgba(255,255,255,0.82)" font-family="sans-serif" '
        f'font-size="12" font-weight="600">{safe_sub}</text>'
        f"</svg>"
    )
    return "data:image/svg+xml;charset=UTF-8," + urllib.parse.quote(svg)


def generate_sample_data() -> Path:
    now_jst = datetime.now(JST)

    def ts_in_days(days: int) -> int:
        dt = (now_jst + timedelta(days=days)).replace(hour=23, minute=59, second=0, microsecond=0)
        return int(dt.astimezone(timezone.utc).timestamp())

    samples = [
        {
            "id": "demo-1",
            "tmdbId": "movie/157336",
            "imdbId": "tt0816692",
            "title": "Interstellar",
            "originalTitle": "Interstellar",
            "titleJa": "インターステラー",
            "showType": "movie",
            "releaseYear": 2014,
            "rating": 87,
            "runtime": 169,
            "seasonCount": None,
            "genres": ["SF", "ドラマ", "アドベンチャー"],
            "overview": "A team of explorers travel through a wormhole in space.",
            "overviewJa": "地球の寿命が尽きかける近未来、元宇宙飛行士のクーパーは人類の新たな居住地を求めワームホールの彼方へと旅立つ。",
            "posterUrl": _svg_poster_data_uri("インターステラー", "SF / 2014", "#0f172a", "#1e3a5f", "#38bdf8"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=%E3%82%A4%E3%83%B3%E3%82%BF%E3%83%BC%E3%82%B9%E3%83%86%E3%83%A9%E3%83%BC&i=instant-video",
            "expiresOn": ts_in_days(2),
            "expiresSoon": True,
        },
        {
            "id": "demo-2",
            "tmdbId": "movie/129",
            "imdbId": "tt0245429",
            "title": "Arrival",
            "originalTitle": "Arrival",
            "titleJa": "メッセージ",
            "showType": "movie",
            "releaseYear": 2016,
            "rating": 80,
            "runtime": 116,
            "seasonCount": None,
            "genres": ["SF", "ミステリー"],
            "overview": "A linguist works with the military to communicate with alien lifeforms.",
            "overviewJa": "突如世界各地に現れた謎の巨大飛行物体。言語学者ルイーズは彼らが伝えようとするメッセージの解読に挑む。",
            "posterUrl": _svg_poster_data_uri("メッセージ", "SF / 2016", "#1e1b4b", "#312e81", "#a78bfa"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=%E3%83%A1%E3%83%83%E3%82%BB%E3%83%BC%E3%82%B8+Arrival&i=instant-video",
            "expiresOn": ts_in_days(4),
            "expiresSoon": True,
        },
        {
            "id": "demo-3",
            "tmdbId": "tv/95479",
            "imdbId": "tt12343534",
            "title": "Jujutsu Kaisen",
            "originalTitle": "呪術廻戦",
            "titleJa": "呪術廻戦",
            "showType": "series",
            "releaseYear": 2020,
            "rating": 86,
            "runtime": None,
            "seasonCount": 2,
            "genres": ["アニメ", "アクション", "ファンタジー"],
            "overview": "A boy swallows a cursed talisman and joins a secret organization of Jujutsu Sorcerers.",
            "overviewJa": "驚異的な身体能力を持つ少年・虎杖悠仁は、特級呪物を飲み込んだことから呪術師たちの戦いへと身を投じる。",
            "posterUrl": _svg_poster_data_uri("呪術廻戦", "アニメ / 全2シーズン", "#18181b", "#4c1d95", "#f43f5e"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=%E5%91%AA%E8%A1%93%E5%BB%BB%E6%88%A6&i=instant-video",
            "expiresOn": ts_in_days(6),
            "expiresSoon": True,
        },
        {
            "id": "demo-4",
            "tmdbId": "movie/335984",
            "imdbId": "tt1856101",
            "title": "Blade Runner 2049",
            "originalTitle": "Blade Runner 2049",
            "titleJa": "ブレードランナー 2049",
            "showType": "movie",
            "releaseYear": 2017,
            "rating": 80,
            "runtime": 164,
            "seasonCount": None,
            "genres": ["SF", "スリラー"],
            "overview": "Young Blade Runner K discovers a long-buried secret.",
            "overviewJa": "2049年のロサンゼルス。捜査官Kは社会の根幹を揺るがす秘密を掘り起こし、30年前に姿を消した元捜査官を追う。",
            "posterUrl": _svg_poster_data_uri("ブレードランナー 2049", "SF / 2017", "#431407", "#9a3412", "#fb923c"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=%E3%83%96%E3%83%AC%E3%83%BC%E3%83%89%E3%83%A9%E3%83%B3%E3%83%8A%E3%83%BC+2049&i=instant-video",
            "expiresOn": ts_in_days(11),
            "expiresSoon": True,
        },
        {
            "id": "demo-5",
            "tmdbId": "tv/1399",
            "imdbId": "tt4574334",
            "title": "The Expanse (Sample)",
            "originalTitle": "Dr.STONE",
            "titleJa": "Dr.STONE",
            "showType": "series",
            "releaseYear": 2019,
            "rating": 83,
            "runtime": None,
            "seasonCount": 3,
            "genres": ["アニメ", "SF", "アドベンチャー"],
            "overview": "Humanity is petrified and a scientific genius works to rebuild civilization.",
            "overviewJa": "謎の現象で全人類が石化してから数千年。超人的な頭脳を持つ科学少年・千空がゼロから文明を再興する。",
            "posterUrl": _svg_poster_data_uri("Dr.STONE", "アニメ / 全3シーズン", "#064e3b", "#0f766e", "#34d399"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=Dr.STONE&i=instant-video",
            "expiresOn": ts_in_days(16),
            "expiresSoon": True,
        },
        {
            "id": "demo-6",
            "tmdbId": "movie/496243",
            "imdbId": "tt6751668",
            "title": "Parasite",
            "originalTitle": "기생충",
            "titleJa": "パラサイト 半地下の家族",
            "showType": "movie",
            "releaseYear": 2019,
            "rating": 85,
            "runtime": 132,
            "seasonCount": None,
            "genres": ["ドラマ", "スリラー", "コメディ"],
            "overview": "Greed and class discrimination threaten the newly formed symbiotic relationship.",
            "overviewJa": "半地下住宅で暮らす貧しい一家が、裕福なIT社長一家の豪邸へ次々と入り込んでいく予測不能のサスペンス。",
            "posterUrl": _svg_poster_data_uri("パラサイト 半地下の家族", "スリラー / 2019", "#1f2937", "#374151", "#facc15"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=%E3%83%91%E3%83%A9%E3%82%B5%E3%82%A4%E3%83%88+%E5%8D%8A%E5%9C%B0%E4%B8%8B%E3%81%AE%E5%AE%B6%E6%97%8F&i=instant-video",
            "expiresOn": ts_in_days(24),
            "expiresSoon": True,
        },
        {
            "id": "demo-7",
            "tmdbId": "movie/27205",
            "imdbId": "tt1375666",
            "title": "Inception",
            "originalTitle": "Inception",
            "titleJa": "インセプション",
            "showType": "movie",
            "releaseYear": 2010,
            "rating": 84,
            "runtime": 148,
            "seasonCount": None,
            "genres": ["アクション", "SF", "スリラー"],
            "overview": "A thief who steals corporate secrets through dream-sharing technology.",
            "overviewJa": "他人の潜在意識に入り込みアイデアを盗み出すプロフェッショナルが、逆にアイデアを植え付ける難関ミッションに挑む。",
            "posterUrl": _svg_poster_data_uri("インセプション", "SF / 2010", "#0c4a6e", "#1e293b", "#60a5fa"),
            "backdropUrl": "",
            "primeLink": "https://www.amazon.co.jp/s?k=%E3%82%A4%E3%83%B3%E3%82%BB%E3%83%97%E3%82%B7%E3%83%A7%E3%83%B3&i=instant-video",
            "expiresOn": None,
            "expiresSoon": True,
        },
    ]

    demo_watchlist = ["インターステラー", "呪術廻戦"]
    items = enrich_and_sort_items(
        samples,
        watchlist_entries=demo_watchlist,
        tmdb_client=None,
        now_jst=now_jst,
    )
    doc = build_output_document(
        items,
        now_jst,
        is_demo=True,
        country="jp",
        catalog="prime.subscription",
        provider="sample-demo",
        tmdb_enabled=True,
        repo_watchlist_count=len(demo_watchlist),
    )

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    EXPIRING_JSON_PATH.write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return EXPIRING_JSON_PATH


if __name__ == "__main__":
    out = generate_sample_data()
    print(f"Generated sample data at {out}")
