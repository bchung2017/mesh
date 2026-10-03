"""Presence: the app's derived read on how present you are in a community,
computed from its contribution log. Pure functions, no I/O.

The model: each contribution has a weight (1..10) and a date. Its influence
fades with age (exponential decay, half-life ~TAU), so presence reflects recent
investment and decays when you stop showing up. Raw score R is the decayed sum;
involvement is a saturating 0..100 curve of R so each community stands alone.
Mode mix is each mode's share of R — "mostly builder, no leadership."
"""
import math
from datetime import date

MODES = ["built", "organized", "served", "led", "connected"]

TAU_DAYS = 90.0   # influence half-life ~= TAU * ln(2) ≈ 62 days
K = 15.0          # saturation: R = K → involvement ≈ 63; defines a "strong" community


def _decayed(weight: float, age_days: float) -> float:
    return weight * math.exp(-max(0.0, age_days) / TAU_DAYS)


def compute_presence(contributions, today: date | None = None) -> dict:
    """contributions: iterable of objects with .date (YYYY-MM-DD), .mode, .weight."""
    today = today or date.today()
    rows = list(contributions)

    R = 0.0
    R_prev = 0.0   # same formula with every age +30d, for an honest month-over-month delta
    mode_score = {m: 0.0 for m in MODES}
    last_date: str | None = None
    recent_30 = 0

    for c in rows:
        try:
            d = date.fromisoformat(c.date)
        except (TypeError, ValueError):
            continue
        age = (today - d).days
        s = _decayed(c.weight, age)
        R += s
        R_prev += _decayed(c.weight, age + 30)
        if c.mode in mode_score:
            mode_score[c.mode] += s
        if last_date is None or c.date > last_date:
            last_date = c.date
        if 0 <= age <= 30:
            recent_30 += 1

    involvement = round(100 * (1 - math.exp(-R / K)))
    involvement_prev = round(100 * (1 - math.exp(-R_prev / K)))
    delta = involvement - involvement_prev
    mode_mix = {m: (round(mode_score[m] / R * 100) if R > 0 else 0) for m in MODES}

    # cosmetic energy label from recency + trend
    if recent_30 and delta >= 3:
        energy = "humming"
    elif recent_30 and delta > 0:
        energy = "warming"
    elif recent_30:
        energy = "steady"
    elif R > 0:
        energy = "cooling"
    else:
        energy = "quiet"

    return {
        "involvement": involvement,
        "delta": delta,
        "modeMix": mode_mix,
        "energy": energy,
        "contributionCount": len(rows),
        "lastContribution": last_date,
    }
