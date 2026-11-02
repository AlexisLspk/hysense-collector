"""Price data for every listed asset, in the shape the detail pages expect:
{price, marketCap, volume24h, range, change24h, change24hAbsolute}.
"""

from __future__ import annotations

import logging
import math
import time
import warnings
from typing import Any

import ccxt
import pandas as pd
import requests
import yfinance as yf

# yfinance logs every unknown ticker and triggers pandas deprecation warnings internally
logging.getLogger("yfinance").setLevel(logging.CRITICAL)
warnings.filterwarnings("ignore", module=r"yfinance(\..*)?")

CRYPTO_EXCHANGES = ["kucoin", "okx", "gate", "bitget"]
SHARES_REFRESH_PER_RUN = 40
SHARES_MAX_AGE_SECONDS = 7 * 24 * 3600


def _num(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _entry(price, market_cap=None, volume=None, rng=None, change_pct=None, change_abs=None) -> dict[str, Any]:
    return {
        "price": _num(price),
        "marketCap": _num(market_cap),
        "volume24h": _num(volume),
        "range": _num(rng),
        "change24h": _num(change_pct),
        "change24hAbsolute": _num(change_abs),
    }


def stock_quotes(symbols: list[str], shares: dict[str, list[float]]) -> dict[str, dict[str, Any]]:
    """One batched yfinance download for all symbols; market cap = price x cached shares outstanding."""
    if not symbols:
        return {}
    yahoo = {s: s.replace(".", "-") for s in symbols}
    df = yf.download(
        list(yahoo.values()), period="5d", interval="1d", group_by="ticker",
        auto_adjust=False, threads=True, progress=False,
    )
    quotes: dict[str, dict[str, Any]] = {}
    for symbol, ysym in yahoo.items():
        try:
            frame = df[ysym] if isinstance(df.columns, pd.MultiIndex) else df
        except KeyError:
            continue
        frame = frame.dropna(subset=["Close"])
        if frame.empty:
            continue
        last = frame.iloc[-1]
        price = _num(last["Close"])
        if price is None:
            continue
        prev = _num(frame.iloc[-2]["Close"]) if len(frame) > 1 else None
        change_abs = price - prev if prev else None
        change_pct = change_abs / prev * 100 if prev else None
        high, low = _num(last["High"]), _num(last["Low"])
        rng = high - low if high and low else None
        share_count = shares.get(symbol, [None])[0]
        market_cap = price * share_count if share_count else None
        quotes[symbol] = _entry(price, market_cap, last["Volume"], rng, change_pct, change_abs)
    return quotes


def refresh_shares(symbols: list[str], shares: dict[str, list[float]], now: float) -> int:
    """Refresh shares outstanding for a few stale symbols per run (one Yahoo call each)."""
    stale = [s for s in symbols if s not in shares or now - shares[s][1] > SHARES_MAX_AGE_SECONDS]
    refreshed = 0
    for symbol in stale[:SHARES_REFRESH_PER_RUN]:
        try:
            count = _num(yf.Ticker(symbol.replace(".", "-")).fast_info.get("shares"))
        except Exception:  # yfinance raises many different errors for unknown tickers
            count = None
        # Remember misses too, so unknown tickers aren't retried every run
        shares[symbol] = [count or 0, now]
        refreshed += 1
    return refreshed


def coingecko_market_caps() -> dict[str, float]:
    caps: dict[str, float] = {}
    for page in (1, 2):
        res = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={"vs_currency": "usd", "order": "market_cap_desc", "per_page": 250, "page": page},
            timeout=20,
        )
        res.raise_for_status()
        for coin in res.json():
            symbol = str(coin.get("symbol", "")).upper()
            # Sorted by market cap, so the first coin with a given symbol is the main one
            if symbol and symbol not in caps and coin.get("market_cap"):
                caps[symbol] = float(coin["market_cap"])
        time.sleep(1.5)
    return caps


def crypto_quotes(symbols: list[str]) -> dict[str, dict[str, Any]]:
    """All tickers from one exchange in a single call, falling back to the next exchange for missing pairs."""
    remaining = set(symbols)
    quotes: dict[str, dict[str, Any]] = {}
    for name in CRYPTO_EXCHANGES:
        if not remaining:
            break
        try:
            tickers = getattr(ccxt, name)({"timeout": 20000}).fetch_tickers()
        except Exception as e:  # network or exchange-specific errors
            print(f"  ! {name}: {e}")
            continue
        for symbol in list(remaining):
            t = tickers.get(f"{symbol}/USDT") or tickers.get(f"{symbol}/USD")
            if not t or _num(t.get("last")) is None:
                continue
            high, low = _num(t.get("high")), _num(t.get("low"))
            rng = high - low if high and low else None
            volume = t.get("baseVolume") if t.get("baseVolume") is not None else t.get("quoteVolume")
            quotes[symbol] = _entry(t["last"], None, volume, rng, t.get("percentage"), t.get("change"))
            remaining.discard(symbol)

    try:
        caps = coingecko_market_caps()
        for symbol, q in quotes.items():
            q["marketCap"] = caps.get(symbol)
    except requests.RequestException as e:
        print(f"  ! coingecko: {e}")
    return quotes
