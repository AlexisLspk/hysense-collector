"""ApeWisdom mentions, shaped exactly like the old /api/stocks and /api/cryptos responses."""

from __future__ import annotations

import html
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests

from hype import calculate_hype_score, js_round

BASE_URL = "https://apewisdom.io/api/v1.0/filter/{filter}/page/{page}"
CONTROL_AND_NULL = re.compile(r"[\x00-\x1f\x7f]")
TICKER_RE = re.compile(r"^[A-Za-z0-9._-]{1,20}$")


def sanitize_ticker(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = CONTROL_AND_NULL.sub("", re.sub(r"\.X$", "", value, flags=re.I)).strip()
    return cleaned if TICKER_RE.match(cleaned) else ""


def sanitize_display(value: Any, max_length: int = 200) -> str:
    if not isinstance(value, str):
        return ""
    return CONTROL_AND_NULL.sub("", html.unescape(value).strip())[:max_length]


def to_int(value: Any) -> int | None:
    """parseInt-like: None for missing/invalid values."""
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _get_page(session: requests.Session, filter_name: str, page: int) -> dict[str, Any]:
    url = BASE_URL.format(filter=filter_name, page=page)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            res = session.get(url, timeout=15)
            res.raise_for_status()
            return res.json()
        except (requests.RequestException, ValueError) as e:
            last_error = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"ApeWisdom {filter_name} page {page} failed: {last_error}")


def fetch_all(filter_name: str) -> list[dict[str, Any]]:
    session = requests.Session()
    session.headers["User-Agent"] = "HySense/1.0 (+https://github.com)"
    first = _get_page(session, filter_name, 1)
    pages = int(first.get("pages") or 1)
    results = list(first.get("results") or [])

    failed = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(_get_page, session, filter_name, p) for p in range(2, pages + 1)]
        for f in futures:
            try:
                results.extend(f.result().get("results") or [])
            except RuntimeError as e:
                failed += 1
                print(f"  ! {e}")

    if pages - failed < math.ceil(pages * 0.8):
        raise RuntimeError(f"ApeWisdom {filter_name}: only {pages - failed}/{pages} pages succeeded")

    seen: set[str] = set()
    unique = []
    for r in results:
        if r.get("ticker") in seen:
            continue
        seen.add(r.get("ticker"))
        unique.append({**r, "name": html.unescape(r.get("name") or "")})
    return unique


def _maxima(rows: list[dict[str, Any]]) -> tuple[int, int]:
    max_mentions = max([to_int(r.get("mentions")) or 0 for r in rows] + [1])
    max_upvotes = max([to_int(r.get("upvotes")) or 0 for r in rows] + [1])
    return max_mentions, max_upvotes


def build_stocks(raw: list[dict[str, Any]], timestamp: str) -> dict[str, Any]:
    max_mentions, max_upvotes = _maxima(raw)
    stocks = []
    for s in raw:
        mentions = to_int(s.get("mentions")) or 0
        upvotes = to_int(s.get("upvotes")) or 0
        rank = to_int(s.get("rank")) or 0
        rank_24h = to_int(s.get("rank_24h_ago")) or None
        mentions_24h = to_int(s.get("mentions_24h_ago")) or None

        mentions_change = js_round((mentions - mentions_24h) / mentions_24h * 100) if mentions_24h else 0
        rank_change = rank_24h - rank if rank_24h else 0
        score = calculate_hype_score(mentions, upvotes, rank, rank_24h, mentions_24h, max_mentions, max_upvotes)

        symbol = sanitize_ticker(s.get("ticker")) or re.sub(r"[^A-Za-z0-9._-]", "", str(s.get("ticker")))[:20]
        stocks.append({
            **s,
            "name": sanitize_display(s.get("name")),
            "symbol": symbol,
            "ticker": symbol,
            "mentions_change_24h": str(mentions_change),
            "rank_change": str(rank_change),
            "hype_scores": [{"score": score}],
        })

    stocks.sort(key=lambda x: x["hype_scores"][0]["score"], reverse=True)
    return {
        "stocks": stocks,
        "total": len(stocks),
        "page": 1,
        "limit": len(stocks),
        "totalPages": 1,
        "timestamp": timestamp,
    }


def build_cryptos(raw: list[dict[str, Any]], timestamp: str) -> dict[str, Any]:
    max_mentions, max_upvotes = _maxima(raw)
    cryptos = []
    for c in raw:
        ticker = sanitize_ticker(c.get("ticker"))
        if not ticker:
            continue
        mentions = to_int(c.get("mentions")) or 0
        upvotes = to_int(c.get("upvotes")) or 0
        rank = to_int(c.get("rank")) or 0
        rank_24h = to_int(c.get("rank_24h_ago")) or None
        mentions_24h = to_int(c.get("mentions_24h_ago")) or None

        mentions_change = (mentions - mentions_24h) / mentions_24h * 100 if mentions_24h else 0
        rank_change = rank_24h - rank if rank_24h is not None else 0
        score = calculate_hype_score(mentions, upvotes, rank, rank_24h, mentions_24h, max_mentions, max_upvotes)

        cryptos.append({
            "id": ticker.lower(),
            "symbol": ticker,
            "name": sanitize_display(c.get("name")),
            "rank": rank,
            "rank_change": rank_change,
            "mentions": mentions,
            "mentions_change_24h": mentions_change,
            "upvotes": upvotes,
            "hype_scores": [{
                "score": score,
                "reddit_mentions": mentions,
                "upvotes": upvotes,
                "rank": rank,
                "rank_change": rank_change,
                "mentions_change_24h": mentions_change,
            }],
        })

    cryptos.sort(key=lambda x: x["hype_scores"][0]["score"], reverse=True)
    return {"success": True, "cryptos": cryptos, "total": len(cryptos), "last_updated": timestamp}
