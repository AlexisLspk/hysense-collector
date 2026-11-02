"""HyScore formula, ported 1:1 from lib/utils/hype-calculator.ts."""

import math


def js_round(x: float) -> int:
    """Math.round semantics (half rounds up), unlike Python's banker's rounding."""
    return math.floor(x + 0.5)


def calculate_hype_score(
    mentions: int,
    upvotes: int,
    rank: int,
    rank_24h_ago: int | None,
    mentions_24h_ago: int | None,
    max_mentions: float = 1000,
    max_upvotes: float = 10000,
) -> int:
    # Base score (50 points)
    mention_score = min((mentions / max_mentions) * 30, 30)
    upvote_score = min((upvotes / max_upvotes) * 10, 10)
    engagement_ratio = upvotes / mentions if mentions > 0 else 0
    engagement_score = min(engagement_ratio * 2, 10)
    base_score = mention_score + upvote_score + engagement_score

    # Momentum score (50 points)
    momentum_score = 0.0

    if rank_24h_ago and rank_24h_ago > rank:
        momentum_score += min((rank_24h_ago - rank) * 1.5, 15)

    if mentions_24h_ago and mentions_24h_ago > 0:
        growth_rate = (mentions - mentions_24h_ago) / mentions_24h_ago

        if growth_rate > 0:
            if growth_rate >= 2:
                growth_score = 35.0
            elif growth_rate >= 1:
                growth_score = 25 + (growth_rate - 1) * 10
            elif growth_rate >= 0.5:
                growth_score = 15 + (growth_rate - 0.5) * 20
            else:
                growth_score = growth_rate * 30
        else:
            growth_score = max(growth_rate * 10, -15)

        if mentions > 200:
            growth_score += min((mentions / max_mentions) * 10, 10)

        if rank_24h_ago and rank_24h_ago > rank and growth_rate > 0:
            growth_score += min((rank_24h_ago - rank) * 0.5, 5)

        momentum_score += min(growth_score, 45)

    return max(0, min(100, js_round(base_score + momentum_score)))
