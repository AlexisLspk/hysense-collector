"""HySense collector: runs every 5 minutes on GitHub Actions.

Fetches ApeWisdom mentions, computes HyScores, appends history points, refreshes prices,
and stores everything in the database read by the Next.js API routes.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from typing import Any

import apewisdom
import markets
import sentiment
from store import Store

# A point is always written at least this often, even when nothing changed,
# so charts keep a regular baseline without writing identical rows every 5 minutes.
HISTORY_HEARTBEAT_SECONDS = 3600


def iso_minute(dt: datetime) -> str:
    return dt.replace(second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:00.000Z")


def history_statements(
    asset_type: str,
    assets: list[dict[str, Any]],
    last_points: dict[str, list[Any]],
    now: int,
    day: str,
) -> list:
    statements = []
    for a in assets:
        symbol = a["symbol"]
        values = [
            a["hype_scores"][0]["score"],
            int(a.get("mentions") or 0),
            int(a.get("upvotes") or 0),
            int(a.get("rank_change") or 0),
        ]
        key = f"{asset_type}:{symbol}"
        previous = last_points.get(key)
        if previous and previous[1:] == values and now - previous[0] < HISTORY_HEARTBEAT_SECONDS:
            continue
        point = [now, *values]
        statements.append(Store.append_point(asset_type, symbol, day, point))
        last_points[key] = point
    return statements


def merge_quotes(previous: dict[str, Any], fresh: dict[str, Any], symbols: list[str]) -> dict[str, Any]:
    """Fresh quotes for listed symbols, falling back to the last known quote; keep everything if the list is unknown."""
    if not symbols:
        return previous
    merged = {s: fresh.get(s) or previous.get(s) for s in symbols}
    return {s: q for s, q in merged.items() if q}


def main() -> int:
    started = time.time()
    now_dt = datetime.now(timezone.utc)
    now = int(now_dt.timestamp())
    timestamp = iso_minute(now_dt)
    day = now_dt.strftime("%Y-%m-%d")

    store = Store()
    print(f"HySense collector @ {timestamp} → {store.describe()}")

    last_points: dict[str, list[Any]] = store.get_json("meta", "key", "history_last", "value") or {}
    statements: list = []
    summary: dict[str, Any] = {"timestamp": timestamp}
    listed: dict[str, list[str]] = {"stock": [], "crypto": []}
    ranked_assets: list[dict[str, Any]] = []

    for asset_type, filter_name, build, list_key in (
        ("stock", "all-stocks", apewisdom.build_stocks, "stocks"),
        ("crypto", "all-crypto", apewisdom.build_cryptos, "cryptos"),
    ):
        try:
            payload = build(apewisdom.fetch_all(filter_name), timestamp)
        except Exception as e:  # keep the previous snapshot if ApeWisdom is down
            print(f"  ! {list_key}: {e}")
            summary[list_key] = f"error: {e}"
            continue
        assets = payload[list_key]
        listed[asset_type] = [a["symbol"] for a in assets]
        ranked_assets.extend(
            {"type": asset_type, "symbol": a["symbol"], "name": a["name"], "score": a["hype_scores"][0]["score"]}
            for a in assets
        )
        statements.append(Store.put_snapshot(list_key, payload, timestamp))
        history = history_statements(asset_type, assets, last_points, now, day)
        statements.extend(history)
        summary[list_key] = {"count": len(assets), "history_points": len(history)}
        print(f"  {list_key}: {len(assets)} assets, {len(history)} history points")

    # Forget assets that dropped out of the lists so the state row doesn't grow forever
    active = {f"{t}:{s}" for t, symbols in listed.items() for s in symbols}
    if listed["stock"] and listed["crypto"]:
        last_points = {k: v for k, v in last_points.items() if k in active}
    statements.append(Store.put_meta("history_last", last_points))

    market = store.get_json("snapshots", "kind", "market", "payload") or {"stocks": {}, "cryptos": {}}
    shares: dict[str, list[float]] = store.get_json("meta", "key", "shares", "value") or {}
    try:
        refreshed = markets.refresh_shares(listed["stock"], shares, now)
        quotes = markets.stock_quotes(listed["stock"], shares)
        market["stocks"] = merge_quotes(market["stocks"], quotes, listed["stock"])
        statements.append(Store.put_meta("shares", shares))
        summary["stock_quotes"] = {"count": len(quotes), "shares_refreshed": refreshed}
        print(f"  stock quotes: {len(quotes)}/{len(listed['stock'])} ({refreshed} share counts refreshed)")
    except Exception as e:  # keep previous prices
        print(f"  ! stock quotes: {e}")
        summary["stock_quotes"] = f"error: {e}"
    try:
        quotes = markets.crypto_quotes(listed["crypto"])
        market["cryptos"] = merge_quotes(market["cryptos"], quotes, listed["crypto"])
        summary["crypto_quotes"] = {"count": len(quotes)}
        print(f"  crypto quotes: {len(quotes)}/{len(listed['crypto'])}")
    except Exception as e:
        print(f"  ! crypto quotes: {e}")
        summary["crypto_quotes"] = f"error: {e}"
    market["timestamp"] = timestamp
    statements.append(Store.put_snapshot("market", market, timestamp))

    try:
        rows = store.query("SELECT type, symbol, updated_at FROM sentiment")
        last_sentiment = {f"{r['type']}:{r['symbol']}": int(r["updated_at"]) for r in rows}
        results = sentiment.collect(ranked_assets, last_sentiment, now_dt, timestamp)
        statements.extend(Store.put_sentiment(t, s, payload, now) for (t, s), payload in results.items())
        headlines = sum(p["summary"]["total_posts"] for p in results.values())
        summary["sentiment"] = {"assets": len(results), "headlines": headlines}
        print(f"  sentiment: {len(results)} assets refreshed, {headlines} headlines scored")
    except Exception as e:  # keep previous sentiment
        print(f"  ! sentiment: {e}")
        summary["sentiment"] = f"error: {e}"

    summary["duration_seconds"] = round(time.time() - started, 1)
    statements.append(Store.put_meta("last_run", summary))
    store.batch(statements)
    print(f"Done in {summary['duration_seconds']}s, {len(statements)} statements")

    # Fail the run (visible in GitHub) only if nothing at all could be collected
    return 0 if listed["stock"] or listed["crypto"] else 1


if __name__ == "__main__":
    sys.exit(main())
