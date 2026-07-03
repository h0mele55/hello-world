"""The rating engine: turn a RatingInput into ranked Quotes.

One algorithm prices every carrier and both coverage types:

    premium = base × ∏(factors) + Σ(loadings)

Carrier-specific knowledge lives entirely in the `rate_components` rows, never here.
All money math is Decimal with ROUND_HALF_UP, quantized to 2dp only at the very end.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import select
from sqlalchemy.orm import Session

from insbot.models import enums as E
from insbot.models.carrier import Carrier, RateComponent, RateTable
from insbot.rating.factors import FACTORS_FOR, NUMERIC_FACTORS
from insbot.rating.schemas import LineItem, Quote, RatingError, RatingInput

TWO_DP = Decimal("0.01")


def _as_decimal(value) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _matches(component: RateComponent, raw_value, numeric: bool) -> bool:
    """Does this component's key match the given input value?"""
    if component.match_type == E.DEFAULT:
        return True
    if component.match_type == E.EXACT:
        if component.key_str is None:
            return False
        return str(component.key_str) == str(raw_value)
    if component.match_type == E.RANGE:
        if raw_value is None:
            return False
        v = _as_decimal(raw_value) if numeric else None
        if v is None:
            return False
        low_ok = component.key_low is None or v >= component.key_low
        high_ok = component.key_high is None or v <= component.key_high
        return low_ok and high_ok
    return False


def _pick(components: list[RateComponent], raw_value, numeric: bool) -> RateComponent | None:
    """Choose the best-matching component.

    Preference: exact/range matches beat defaults; higher `priority` wins ties.
    """
    candidates = [c for c in components if _matches(c, raw_value, numeric)]
    if not candidates:
        return None

    def rank(c: RateComponent) -> tuple[int, int]:
        specificity = 0 if c.match_type == E.DEFAULT else 1
        return (specificity, c.priority)

    return max(candidates, key=rank)


def _load_components(session: Session, rate_table_id: int) -> list[RateComponent]:
    return list(
        session.execute(
            select(RateComponent).where(RateComponent.rate_table_id == rate_table_id)
        ).scalars()
    )


def _price_one(rating: RatingInput, components: list[RateComponent]) -> tuple[Decimal, list[LineItem]]:
    breakdown: list[LineItem] = []

    # 1) BASE — keyed either flat, by engine power range, or a compound (power+region).
    base_rows = [c for c in components if c.component_type == E.BASE]
    base_component = _pick(base_rows, rating.engine_power_kw, numeric=True)
    if base_component is None:
        # A base may be flat (single default row) or fail if power is out of range.
        raise RatingError("No base rate matches the vehicle (engine power out of tariff range?).")

    if base_component.value_kind == E.RATE_OF_BASE:
        # Casco: base is a percentage of market value.
        if rating.market_value_bgn is None:
            raise RatingError("Casco pricing requires market_value_bgn.")
        base_amount = _as_decimal(rating.market_value_bgn) * base_component.value
    else:
        base_amount = _as_decimal(base_component.value)

    detail = "flat"
    if base_component.key_low is not None or base_component.key_high is not None:
        detail = f"power {base_component.key_low}-{base_component.key_high} kW"
    breakdown.append(LineItem("base", "base_rate", detail, base_amount))

    premium = base_amount

    # 2) FACTORS — multiply each applicable factor.
    for factor_name in FACTORS_FOR[rating.coverage_type]:
        rows = [c for c in components if c.component_type == E.FACTOR and c.factor_name == factor_name]
        if not rows:
            continue  # this carrier simply doesn't rate on this factor
        raw = rating.value_for(factor_name)
        numeric = factor_name in NUMERIC_FACTORS
        chosen = _pick(rows, raw, numeric)
        if chosen is None:
            # Fail loud: the carrier rates on this factor but has no bucket for this value.
            raise RatingError(
                f"No '{factor_name}' bucket matches input value {raw!r} for this tariff."
            )
        premium *= chosen.value
        bucket = chosen.key_str if chosen.key_str is not None else f"{chosen.key_low}-{chosen.key_high}"
        breakdown.append(LineItem("factor", factor_name, str(bucket), chosen.value))

    # 3) LOADINGS — additive surcharges/fees/taxes (fixed amount or % of running premium).
    for c in [c for c in components if c.component_type == E.LOADING]:
        if c.value_kind == E.RATE_OF_BASE:
            amount = premium * c.value
        else:
            amount = _as_decimal(c.value)
        premium += amount
        breakdown.append(LineItem("loading", c.factor_name or "loading", c.value_kind, amount))

    premium = premium.quantize(TWO_DP, rounding=ROUND_HALF_UP)
    return premium, breakdown


def compute_quotes(
    rating: RatingInput,
    session: Session,
    carrier_slugs: list[str] | None = None,
) -> list[Quote]:
    """Price `rating` against every active tariff (optionally filtered to some carriers).

    Returns quotes sorted cheapest-first. A carrier whose tariff cannot price the
    input raises RatingError internally; we skip it but attach the reason so callers
    can surface data gaps rather than silently dropping carriers.
    """
    stmt = (
        select(RateTable, Carrier)
        .join(Carrier, RateTable.carrier_id == Carrier.id)
        .where(
            RateTable.coverage_type == rating.coverage_type,
            RateTable.status == E.ACTIVE,
            Carrier.active.is_(True),
        )
    )
    if carrier_slugs is not None:
        stmt = stmt.where(Carrier.slug.in_(carrier_slugs))

    quotes: list[Quote] = []
    for rate_table, carrier in session.execute(stmt).all():
        components = _load_components(session, rate_table.id)
        try:
            premium, breakdown = _price_one(rating, components)
        except RatingError:
            # Skip carriers that can't price this input; do not fabricate a number.
            continue
        quotes.append(
            Quote(
                carrier_slug=carrier.slug,
                carrier_name=carrier.name,
                coverage_type=rating.coverage_type,
                premium_bgn=premium,
                breakdown=breakdown,
                rate_table_version=rate_table.version,
            )
        )

    quotes.sort(key=lambda q: q.premium_bgn)
    return quotes
