"""Demo seed: two hand-entered MTPL tariffs + golden samples.

This is the Stage-1 "one carrier, hand-entered" path — no ingestion pipeline yet.
It doubles as fixtures for the rating tests. The numbers are illustrative, NOT real
carrier tariffs; replace with real data (via the ingestion pipeline) before going live.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from insbot.models import enums as E
from insbot.models.carrier import Carrier, RateComponent, RateTable


def _c(**kw) -> RateComponent:
    kw.setdefault("value_kind", E.MULTIPLIER)
    kw.setdefault("match_type", E.EXACT)
    kw["value"] = Decimal(str(kw["value"]))
    for k in ("key_low", "key_high"):
        if kw.get(k) is not None:
            kw[k] = Decimal(str(kw[k]))
    return RateComponent(**kw)


def _mtpl_components(base_power_bands, region, age, experience) -> list[RateComponent]:
    """Build a full MTPL component set from a few compact dicts."""
    rows: list[RateComponent] = []

    # BASE: keyed by engine-power range, a flat currency amount.
    for low, high, amount in base_power_bands:
        rows.append(
            _c(
                component_type=E.BASE,
                factor_name=E.F_ENGINE_POWER,
                match_type=E.RANGE,
                key_low=low,
                key_high=high,
                value=amount,
                value_kind=E.AMOUNT,
            )
        )

    # REGION factor (exact by canonical code) + a default.
    for code, mult in region.items():
        rows.append(_c(component_type=E.FACTOR, factor_name=E.F_REGION, key_str=code, value=mult))
    rows.append(_c(component_type=E.FACTOR, factor_name=E.F_REGION, match_type=E.DEFAULT, value=1.0))

    # AGE factor (range).
    for low, high, mult in age:
        rows.append(
            _c(component_type=E.FACTOR, factor_name=E.F_AGE, match_type=E.RANGE,
               key_low=low, key_high=high, value=mult)
        )

    # EXPERIENCE factor (range).
    for low, high, mult in experience:
        rows.append(
            _c(component_type=E.FACTOR, factor_name=E.F_EXPERIENCE, match_type=E.RANGE,
               key_low=low, key_high=high, value=mult)
        )

    # BONUS-MALUS (exact class) + default.
    for cls, mult in {"M1": 1.15, "0": 1.00, "B1": 0.95, "B2": 0.90}.items():
        rows.append(_c(component_type=E.FACTOR, factor_name=E.F_BONUS_MALUS, key_str=cls, value=mult))
    rows.append(_c(component_type=E.FACTOR, factor_name=E.F_BONUS_MALUS, match_type=E.DEFAULT, value=1.0))

    # VEHICLE CATEGORY (exact) + default.
    for cat, mult in {"B": 1.00, "C": 1.30, "motorcycle": 0.80}.items():
        rows.append(_c(component_type=E.FACTOR, factor_name=E.F_VEHICLE_CATEGORY, key_str=cat, value=mult))
    rows.append(_c(component_type=E.FACTOR, factor_name=E.F_VEHICLE_CATEGORY, match_type=E.DEFAULT, value=1.0))

    # FIRST-REGISTRATION-YEAR (range of years).
    for low, high, mult in [(1900, 2005, 1.10), (2006, 2015, 1.00), (2016, 2100, 0.98)]:
        rows.append(
            _c(component_type=E.FACTOR, factor_name=E.F_FIRST_REG_YEAR, match_type=E.RANGE,
               key_low=low, key_high=high, value=mult)
        )

    # LOADINGS: 2% insurance tax (of running premium) + fixed statutory fund fee.
    rows.append(_c(component_type=E.LOADING, factor_name="tax_2pct", value=0.02, value_kind=E.RATE_OF_BASE))
    rows.append(_c(component_type=E.LOADING, factor_name="statutory_funds", value=10.13, value_kind=E.AMOUNT))
    return rows


def seed_demo(session: Session) -> dict:
    """Insert two demo carriers with active MTPL tariffs. Returns golden samples."""
    # ---- Carrier A: "Lev Ins" (demo) ----
    lev = Carrier(name="Lev Ins (demo)", slug="lev_ins", active=True)
    session.add(lev)
    session.flush()
    lev_table = RateTable(
        carrier_id=lev.id, coverage_type=E.MTPL, version=1,
        source_format="manual", status=E.ACTIVE, valid_from=date(2026, 1, 1),
    )
    session.add(lev_table)
    session.flush()
    for row in _mtpl_components(
        base_power_bands=[(0, 54, 150), (55, 73, 200), (74, 110, 280), (111, 150, 380), (151, 999, 520)],
        region={"SOF": 1.20, "PDV": 1.05, "VAR": 1.10},
        age=[(18, 24, 1.40), (25, 34, 1.10), (35, 59, 1.00), (60, 120, 1.15)],
        experience=[(0, 1, 1.30), (2, 4, 1.10), (5, 99, 1.00)],
    ):
        row.rate_table_id = lev_table.id
        session.add(row)

    # ---- Carrier B: "Bulstrad" (demo) ----
    bul = Carrier(name="Bulstrad (demo)", slug="bulstrad", active=True)
    session.add(bul)
    session.flush()
    bul_table = RateTable(
        carrier_id=bul.id, coverage_type=E.MTPL, version=1,
        source_format="manual", status=E.ACTIVE, valid_from=date(2026, 1, 1),
    )
    session.add(bul_table)
    session.flush()
    for row in _mtpl_components(
        base_power_bands=[(0, 54, 160), (55, 73, 210), (74, 110, 300), (111, 150, 400), (151, 999, 540)],
        region={"SOF": 1.10, "PDV": 1.05, "VAR": 1.08},
        age=[(18, 24, 1.35), (25, 34, 1.05), (35, 59, 1.00), (60, 120, 1.12)],
        experience=[(0, 1, 1.25), (2, 4, 1.08), (5, 99, 1.00)],
    ):
        row.rate_table_id = bul_table.id
        session.add(row)

    session.commit()

    # Golden samples: (input dict → expected premium). Verified by hand in the design.
    golden = {
        "lev_ins": Decimal("379.58"),   # power90 SOF age30 exp8 bm0 catB reg2018
        "bulstrad": Decimal("356.49"),  # same input, cheaper tariff
    }
    return golden
