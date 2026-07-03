"""Value objects for the rating engine (framework-agnostic, no ORM here)."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from insbot.models import enums as E


@dataclass(frozen=True)
class RatingInput:
    """Everything needed to price one vehicle for one coverage type.

    Casco-only fields default to None; they are required (validated) when
    coverage_type == CASCO.
    """

    coverage_type: str            # "mtpl" | "casco"
    engine_power_kw: int
    registration_region: str      # canonical region code, e.g. "SOF"
    first_registration_year: int
    vehicle_category: str
    owner_age: int
    owner_experience_years: int
    bonus_malus_class: str

    # Casco-only
    market_value_bgn: Decimal | None = None
    coverage_tier: str | None = None      # "mini" | "partial" | "full"
    security: str | None = None           # "none" | "alarm" | "gps" | "immobilizer"
    claims_history: str | None = None     # "0" | "1" | "2+"

    def value_for(self, factor_name: str):
        """Return the raw input value the engine should match for a factor."""
        return {
            E.F_ENGINE_POWER: self.engine_power_kw,
            E.F_REGION: self.registration_region,
            E.F_AGE: self.owner_age,
            E.F_EXPERIENCE: self.owner_experience_years,
            E.F_BONUS_MALUS: self.bonus_malus_class,
            E.F_VEHICLE_CATEGORY: self.vehicle_category,
            E.F_FIRST_REG_YEAR: self.first_registration_year,
            E.F_MARKET_VALUE: self.market_value_bgn,
            E.F_COVERAGE_TIER: self.coverage_tier,
            E.F_SECURITY: self.security,
            E.F_CLAIMS_HISTORY: self.claims_history,
        }[factor_name]


@dataclass
class LineItem:
    kind: str      # "base" | "factor" | "loading"
    name: str
    detail: str    # which bucket matched, e.g. "power 74-110 kW"
    value: Decimal  # multiplier or amount


@dataclass
class Quote:
    carrier_slug: str
    carrier_name: str
    coverage_type: str
    premium_bgn: Decimal
    breakdown: list[LineItem] = field(default_factory=list)
    rate_table_version: int = 0

    def to_dict(self) -> dict:
        return {
            "carrier_slug": self.carrier_slug,
            "carrier_name": self.carrier_name,
            "coverage_type": self.coverage_type,
            "premium_bgn": str(self.premium_bgn),
            "rate_table_version": self.rate_table_version,
            "breakdown": [
                {"kind": li.kind, "name": li.name, "detail": li.detail, "value": str(li.value)}
                for li in self.breakdown
            ],
        }


class RatingError(Exception):
    """Raised when a tariff cannot price an input (missing factor coverage, etc.).

    We fail loud rather than silently applying a 1.0 factor — a gap in the data
    is a bug that must be fixed, not hidden behind a wrong-but-plausible price.
    """
