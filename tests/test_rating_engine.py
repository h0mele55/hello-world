"""Rating-engine tests, including the golden-sample gate."""
from __future__ import annotations

from decimal import Decimal

import pytest

from insbot.rating.engine import compute_quotes
from insbot.rating.schemas import RatingError, RatingInput
from insbot.seed import seed_demo

# The canonical demo input the golden samples were computed for.
DEMO_INPUT = RatingInput(
    coverage_type="mtpl",
    engine_power_kw=90,
    registration_region="SOF",
    first_registration_year=2018,
    vehicle_category="B",
    owner_age=30,
    owner_experience_years=8,
    bonus_malus_class="0",
)


def test_golden_samples_match_to_the_stotinka(session):
    golden = seed_demo(session)
    quotes = compute_quotes(DEMO_INPUT, session)
    by_slug = {q.carrier_slug: q.premium_bgn for q in quotes}
    for slug, expected in golden.items():
        assert by_slug[slug] == expected, f"{slug}: {by_slug[slug]} != {expected}"


def test_quotes_are_ranked_cheapest_first(session):
    seed_demo(session)
    quotes = compute_quotes(DEMO_INPUT, session)
    premiums = [q.premium_bgn for q in quotes]
    assert premiums == sorted(premiums)
    assert quotes[0].carrier_slug == "bulstrad"  # cheaper in the demo tariffs


def test_breakdown_reconstructs_the_premium(session):
    seed_demo(session)
    q = compute_quotes(DEMO_INPUT, session, carrier_slugs=["lev_ins"])[0]
    running = Decimal("0")
    for li in q.breakdown:
        if li.kind == "base":
            running = li.value
        elif li.kind == "factor":
            running *= li.value
        elif li.kind == "loading":
            running += li.value
    assert running.quantize(Decimal("0.01")) == q.premium_bgn


def test_region_default_factor_applies_for_unknown_region(session):
    seed_demo(session)
    inp = RatingInput(
        coverage_type="mtpl", engine_power_kw=90, registration_region="ZZZ",
        first_registration_year=2018, vehicle_category="B", owner_age=30,
        owner_experience_years=8, bonus_malus_class="0",
    )
    # Unknown region falls back to the default 1.0 factor rather than failing.
    quotes = compute_quotes(inp, session)
    assert len(quotes) == 2


def test_fail_loud_when_no_factor_bucket_matches(session):
    seed_demo(session)
    # Age 15 has no bucket (bands start at 18) -> engine must raise, not guess.
    inp = RatingInput(
        coverage_type="mtpl", engine_power_kw=90, registration_region="SOF",
        first_registration_year=2018, vehicle_category="B", owner_age=15,
        owner_experience_years=0, bonus_malus_class="0",
    )
    # compute_quotes skips carriers that can't price; assert the low-level raise directly.
    from insbot.rating.engine import _price_one, _load_components
    from insbot.models.carrier import RateTable
    table = session.query(RateTable).first()
    comps = _load_components(session, table.id)
    with pytest.raises(RatingError):
        _price_one(inp, comps)
