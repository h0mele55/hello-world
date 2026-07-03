"""Which canonical factors apply to each coverage type, and how to read the
input value for each factor out of a RatingInput.

MTPL and Casco share the exact same engine — they differ only in this table.
"""
from __future__ import annotations

from insbot.models import enums as E

# Ordered list of factors the engine multiplies for each coverage.
FACTORS_FOR: dict[str, list[str]] = {
    E.MTPL: [
        E.F_ENGINE_POWER,
        E.F_REGION,
        E.F_AGE,
        E.F_EXPERIENCE,
        E.F_BONUS_MALUS,
        E.F_VEHICLE_CATEGORY,
        E.F_FIRST_REG_YEAR,
    ],
    E.CASCO: [
        E.F_REGION,
        E.F_AGE,
        E.F_EXPERIENCE,
        E.F_BONUS_MALUS,
        E.F_FIRST_REG_YEAR,
        E.F_COVERAGE_TIER,
        E.F_SECURITY,
        E.F_CLAIMS_HISTORY,
    ],
}

# Factors matched on a numeric value (range/exact-numeric) vs a categorical string.
NUMERIC_FACTORS = {
    E.F_ENGINE_POWER,
    E.F_AGE,
    E.F_EXPERIENCE,
    E.F_FIRST_REG_YEAR,
    E.F_MARKET_VALUE,
}
