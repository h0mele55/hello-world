"""Canonical string constants used across models and the rating engine.

Kept as plain module-level strings (not Python enums) so they serialize cleanly
to the DB and to JSON, and so YAML mapping files can reference them by value.
"""
from __future__ import annotations

# Coverage types
MTPL = "mtpl"      # Гражданска отговорност
CASCO = "casco"    # Каско
COVERAGE_TYPES = (MTPL, CASCO)

# rate_components.component_type
BASE = "base"
FACTOR = "factor"
LOADING = "loading"

# rate_components.match_type
EXACT = "exact"
RANGE = "range"
DEFAULT = "default"

# rate_components.value_kind
AMOUNT = "amount"            # a fixed currency amount
MULTIPLIER = "multiplier"    # a factor multiplier (e.g. 1.15)
RATE_OF_BASE = "rate_of_base"  # a fraction applied to a base (e.g. 0.02 = 2%)

# Canonical factor names. MTPL vs Casco pick a subset of these.
F_ENGINE_POWER = "engine_power"
F_REGION = "region"
F_AGE = "age"
F_EXPERIENCE = "experience"
F_BONUS_MALUS = "bonus_malus"
F_VEHICLE_CATEGORY = "vehicle_category"
F_FIRST_REG_YEAR = "first_reg_year"
F_MARKET_VALUE = "market_value"
F_COVERAGE_TIER = "coverage_tier"
F_SECURITY = "security"
F_CLAIMS_HISTORY = "claims_history"

# rate_tables.status lifecycle
DRAFT = "draft"
VALIDATED = "validated"
ACTIVE = "active"
SUPERSEDED = "superseded"

# policies.status
QUOTED = "quoted"
POLICY_ACTIVE = "active"
EXPIRED = "expired"
CANCELLED = "cancelled"

# Reminder milestones (days before expiry)
REMINDER_MILESTONES = (30, 14, 1)
