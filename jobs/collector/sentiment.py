"""News sentiment: headlines from Finviz (pd.read_html) and RSS feeds, scored by the
HySense analyzer (jobs/sentiment, Node), aggregated like the old Reddit sentiment route.

Only part of the assets are refreshed per run: top assets on every run, the rest every 12 hours.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from finance_lexicon import FINANCE_LEXICON

SENTIMENT_DIR = Path(__file__).resolve().parents[1] / "sentiment"
UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
}
EASTERN = ZoneInfo("America/New_York")
CRYPTO_FEEDS = ["https://www.coindesk.com/arc/outboundfeeds/rss/", "https://cointelegraph.com/rss"]

ASSETS_PER_RUN = 60
TOP_ASSETS = 30
# Below the 30-minute run interval so scheduler jitter never skips a refresh
TOP_TTL_SECONDS = 25 * 60
OTHER_TTL_SECONDS = 12 * 3600
MAX_HEADLINES = 30
MAX_AGE = timedelta(days=7)

# Each headline's score is the average of the HySense analyzer and VADER with finance words.
# On hand-labeled headlines the blend matched the label more often than either one alone.
_vader = SentimentIntensityAnalyzer()
_vader.lexicon.update(FINANCE_LEXICON)

# Same thresholds as the old /api/sentiment route
BULLISH_THRESHOLD = 0.15
BEARISH_THRESHOLD = -0.15

Headline = dict[str, Any]


def _headline(title: str, url: str, publisher: str, published: datetime | None) -> Headline:
    return {
        "id": hashlib.sha1(url.encode() or title.encode()).hexdigest()[:16],
        "title": title.strip(),
        "url": url,
        "publisher": publisher.strip(),
        "published_at": published.isoformat() if published else None,
    }


def _recent(headlines: list[Headline], now: datetime, limit: int | None = MAX_HEADLINES) -> list[Headline]:
    fresh = [h for h in headlines if not h["published_at"] or now - datetime.fromisoformat(h["published_at"]) <= MAX_AGE]
    fresh.sort(key=lambda h: h["published_at"] or "", reverse=True)
    seen: set[str] = set()
    unique = []
    for h in fresh:
        key = h["title"].lower()
        if key not in seen:
            seen.add(key)
            unique.append(h)
    return unique[:limit]


def _parse_rss(content: bytes) -> list[Headline]:
    items = []
    for item in ET.fromstring(content).iter("item"):
        title = item.findtext("title") or ""
        source = item.find("source")
        publisher = source.text if source is not None and source.text else ""
        # Google News appends " - Publisher" to titles
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3]
        try:
            published = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            published = None
        items.append(_headline(title, item.findtext("link") or "", publisher, published))
    return items


def google_news(query: str) -> list[Headline]:
    url = f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    res = requests.get(url, headers=UA, timeout=15)
    res.raise_for_status()
    return _parse_rss(res.content)


def finviz_news(symbol: str, now: datetime) -> list[Headline]:
    """Finviz quote page news table via pd.read_html; dates are US Eastern, the date is only shown on its first row."""
    res = requests.get(f"https://finviz.com/quote.ashx?t={symbol.replace('.', '-')}", headers=UA, timeout=15)
    res.raise_for_status()
    table = pd.read_html(io.StringIO(res.text), attrs={"id": "news-table"}, extract_links="body")[0]
    current_day = now.astimezone(EASTERN).date()
    headlines = []
    for (when, _), (text, link) in zip(table.iloc[:, 0], table.iloc[:, 1]):
        when = str(when).strip()
        parts = when.split()
        if len(parts) == 2:
            day = parts[0]
            if day == "Today":
                current_day = now.astimezone(EASTERN).date()
            else:
                try:
                    current_day = datetime.strptime(day, "%b-%d-%y").date()
                except ValueError:
                    pass
        try:
            clock = datetime.strptime(parts[-1], "%I:%M%p").time()
            published = datetime.combine(current_day, clock, tzinfo=EASTERN)
        except ValueError:
            published = None
        text = re.sub(r"\s+[+-]?\d+(\.\d+)?%\s*$", "", str(text))
        match = re.match(r"^(.*?)\s*\(([^()]+)\)\s*$", text)
        title, publisher = (match.group(1), match.group(2)) if match else (text, "Finviz")
        headlines.append(_headline(title, link or "", publisher, published))
    return headlines


def crypto_feed_headlines() -> list[Headline]:
    headlines: list[Headline] = []
    for url in CRYPTO_FEEDS:
        try:
            res = requests.get(url, headers=UA, timeout=15)
            res.raise_for_status()
            headlines.extend(_parse_rss(res.content))
        except (requests.RequestException, ET.ParseError) as e:
            print(f"  ! feed {url}: {e}")
    return headlines


def _about_asset(headlines: list[Headline], symbol: str, name: str, minimum: int = 5) -> list[Headline]:
    """Finviz mixes general market news into ticker pages; keep the ones naming the asset when there are enough."""
    short_name = re.split(r"[\s,(]", name.strip())[0] if name else ""
    terms = [re.escape(symbol)] + ([re.escape(short_name)] if len(short_name) >= 3 else [])
    pattern = re.compile(rf"\b({'|'.join(terms)})\b", re.I)
    named = [h for h in headlines if pattern.search(h["title"])]
    return named if len(named) >= minimum else headlines


def fetch_headlines(asset: dict[str, Any], crypto_feed: list[Headline], now: datetime) -> list[Headline]:
    symbol, name = asset["symbol"], asset["name"]
    if asset["type"] == "stock":
        try:
            headlines = _recent(finviz_news(symbol, now), now, limit=None)
        except Exception as e:  # blocked, unknown ticker or layout change: fall back to RSS
            print(f"  ! finviz {symbol}: {e}")
            headlines = []
        headlines = headlines or _recent(google_news(f'"{symbol}" {name} stock when:7d'), now, limit=None)
        return _about_asset(headlines, symbol, name)[:MAX_HEADLINES]

    pattern = re.compile(rf"\b({re.escape(symbol)}|{re.escape(name)})\b", re.I)
    related = [h for h in crypto_feed if pattern.search(h["title"])]
    try:
        related += google_news(f'"{name}" crypto when:7d')
    except (requests.RequestException, ET.ParseError) as e:
        print(f"  ! google news {symbol}: {e}")
    return _recent(related, now)


def score_headlines(items: list[dict[str, str]], tickers: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    if not items:
        return {}
    proc = subprocess.run(
        ["node_modules/.bin/tsx", "score.ts"],
        cwd=SENTIMENT_DIR,
        input=json.dumps({"tickers": tickers, "items": items}),
        capture_output=True,
        text=True,
        timeout=240,
        check=True,
    )
    return {r["id"]: r for r in json.loads(proc.stdout)}


def aggregate(symbol: str, headlines: list[Headline], updated_at: str) -> dict[str, Any]:
    """Same overall/confidence/trend rules as the old Reddit-based route."""
    scores = [h["sentiment"]["score"] for h in headlines]
    total = len(scores)
    bullish = sum(1 for s in scores if s > BULLISH_THRESHOLD)
    bearish = sum(1 for s in scores if s < BEARISH_THRESHOLD)
    neutral = total - bullish - bearish

    overall, confidence, avg = "NEUTRAL", 0.0, 0.0
    if total:
        avg = sum(scores) / total
        bull_pct, bear_pct, neutral_pct = bullish / total * 100, bearish / total * 100, neutral / total * 100
        if bull_pct >= 50 and avg >= 0.05:
            overall, confidence = "BULLISH", bull_pct
        elif bear_pct >= 50 or avg < -0.05:
            overall, confidence = "BEARISH", bear_pct
        elif avg > 0.2:
            overall, confidence = "BULLISH", bull_pct
        elif avg < -0.2:
            overall, confidence = "BEARISH", bear_pct
        elif bull_pct > bear_pct and avg >= 0.05:
            overall, confidence = "BULLISH", bull_pct
        elif bear_pct > bull_pct:
            overall, confidence = "BEARISH", bear_pct
        else:
            confidence = neutral_pct

    recent, older = scores[:10], scores[10:20]
    recent_avg = sum(recent) / len(recent) if recent else 0
    older_avg = sum(older) / len(older) if older else 0
    trend = "improving" if recent_avg > older_avg + 0.1 else "declining" if recent_avg < older_avg - 0.1 else "stable"

    pct = lambda n: round(n / total * 100) if total else 0  # noqa: E731
    return {
        "symbol": symbol,
        "sentiment": {
            "overall": overall,
            "score": round(avg, 2),
            "comparative": 0,
            "confidence": round(confidence),
            "trend": trend,
        },
        "sources": [
            {
                "id": h["id"],
                "title": h["title"],
                "content": "",
                "url": h["url"],
                "author": h["publisher"],
                "publisher": h["publisher"],
                "score": 0,
                "num_comments": 0,
                "sentiment": {
                    "score": h["sentiment"]["score"],
                    "comparative": h["sentiment"]["confidence"],
                    "market_sentiment": "BULLISH" if h["sentiment"]["score"] > 0.2
                    else "BEARISH" if h["sentiment"]["score"] < -0.2 else "NEUTRAL",
                },
                "created_at": h["published_at"],
                "mentions": [symbol],
            }
            for h in headlines
        ],
        "summary": {
            "total_posts": total,
            "bullish_posts": bullish,
            "bearish_posts": bearish,
            "neutral_posts": neutral,
            "bullish_percentage": pct(bullish),
            "bearish_percentage": pct(bearish),
            "neutral_percentage": pct(neutral),
            "last_updated": updated_at,
        },
    }


def pick_assets(assets: list[dict[str, Any]], last_updated: dict[str, int], now: int) -> list[dict[str, Any]]:
    """Assets ordered by HyScore; refresh the top ones more often, oldest first within each group."""
    ranked = sorted(assets, key=lambda a: a["score"], reverse=True)
    due = []
    for i, a in enumerate(ranked):
        ttl = TOP_TTL_SECONDS if i < TOP_ASSETS else OTHER_TTL_SECONDS
        age = now - last_updated.get(f"{a['type']}:{a['symbol']}", 0)
        if age >= ttl:
            due.append((i >= TOP_ASSETS, -age, a))
    due.sort(key=lambda d: (d[0], d[1]))
    return [a for _, _, a in due[:ASSETS_PER_RUN]]


def collect(assets: list[dict[str, Any]], last_updated: dict[str, int], now_dt: datetime, updated_at: str):
    """Returns {(type, symbol): payload} for the assets refreshed this run."""
    now = int(now_dt.timestamp())
    batch = pick_assets(assets, last_updated, now)
    if not batch:
        return {}

    crypto_feed = crypto_feed_headlines() if any(a["type"] == "crypto" for a in batch) else []
    with ThreadPoolExecutor(max_workers=4) as pool:
        fetched = list(pool.map(lambda a: _safe_fetch(a, crypto_feed, now_dt), batch))

    items = {h["id"]: h["title"] for headlines in fetched for h in headlines}
    tickers = [{"symbol": a["symbol"], "name": a["name"], "type": a["type"]} for a in assets]
    scored = score_headlines([{"id": k, "text": v} for k, v in items.items()], tickers)

    results = {}
    for asset, headlines in zip(batch, fetched):
        if headlines is None:
            continue
        for h in headlines:
            hysense = scored.get(h["id"], {"score": 0, "confidence": 0})
            vader = _vader.polarity_scores(h["title"])["compound"]
            h["sentiment"] = {"score": round((hysense["score"] + vader) / 2, 3), "confidence": hysense["confidence"]}
        results[(asset["type"], asset["symbol"])] = aggregate(asset["symbol"], headlines, updated_at)
    return results


def _safe_fetch(asset: dict[str, Any], crypto_feed: list[Headline], now_dt: datetime) -> list[Headline] | None:
    try:
        return fetch_headlines(asset, crypto_feed, now_dt)
    except Exception as e:  # one bad asset shouldn't stop the batch
        print(f"  ! headlines {asset['symbol']}: {e}")
        return None
    finally:
        time.sleep(0.5)
