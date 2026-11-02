"""Market-news words added to VADER's lexicon (VADER scale: -4 very negative .. +4 very positive).
VADER handles negation, intensifiers and "but"/"despite" clauses; this adds the finance meaning
of words it treats as neutral (e.g. "slides", "beats", "downgrade").
"""

FINANCE_LEXICON: dict[str, float] = {
    # Price moves up
    "higher": 1.5, "rise": 1.5, "rises": 1.5, "rising": 1.5, "climb": 1.5, "climbs": 1.5,
    "gain": 1.5, "gains": 1.5, "jump": 2.0, "jumps": 2.0, "surge": 2.5, "surges": 2.5,
    "soar": 2.5, "soars": 2.5, "rally": 2.0, "rallies": 2.0, "rallying": 2.0,
    "rebound": 1.8, "rebounds": 1.8, "bounces": 1.2, "lifts": 1.5, "boost": 1.8, "boosts": 1.8,
    "outperform": 2.0, "outperforms": 2.0, "record": 1.0, "highs": 1.5,
    # Price moves down
    "lower": -1.5, "fall": -2.0, "falls": -2.0, "drop": -2.0, "drops": -2.0, "decline": -2.0,
    "declines": -2.0, "slide": -2.0, "slides": -2.0, "slips": -1.5, "dip": -1.2, "dips": -1.2,
    "sink": -2.5, "sinks": -2.5, "tumble": -2.5, "tumbles": -2.5, "plunge": -3.0, "plunges": -3.0,
    "selloff": -2.5, "sell-off": -2.5, "underperform": -2.0, "underperforms": -2.0,
    "lows": -2.0, "hammered": -2.5, "clobbered": -3.0, "stutter": -1.5, "stutters": -1.5,
    # Results and analysts
    "beat": 2.0, "beats": 2.0, "miss": -2.0, "misses": -2.0, "upgrade": 2.5, "upgrades": 2.5,
    "downgrade": -2.5, "downgrades": -2.5, "raises": 1.5, "raised": 1.5, "cuts": -1.5, "trim": -1.0,
    "bullish": 2.5, "bearish": -2.5, "buyback": 1.5, "approval": 2.0, "expands": 1.0,
    # Risk events
    "hack": -3.0, "heist": -3.0, "lawsuit": -2.5, "sued": -2.5, "probe": -2.0, "fraud": -3.0,
    "warns": -2.0, "fears": -2.0, "jitteriness": -1.5, "jitters": -1.5, "rattled": -2.0, "rattles": -2.0,
    "bankruptcy": -3.5, "delisting": -3.0, "layoffs": -2.0,
}
