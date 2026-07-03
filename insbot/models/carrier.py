"""Carriers, their uploaded rate tables, and the canonical normalized rows.

`RateComponent` is the single most important table in the system: every carrier's
tariff — whatever its original shape — is flattened into rows of this one table so
the rating engine never has to know carrier-specific layout.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from insbot.app.db import Base


class Carrier(Base):
    __tablename__ = "carriers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(96))
    slug: Mapped[str] = mapped_column(String(48), unique=True)  # e.g. "lev_ins"
    active: Mapped[bool] = mapped_column(default=True)
    mapping_config_path: Mapped[str | None] = mapped_column(String(256), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    rate_tables: Mapped[list["RateTable"]] = relationship(back_populates="carrier")


class RateTable(Base):
    """One uploaded tariff file, versioned per (carrier, coverage_type)."""

    __tablename__ = "rate_tables"
    __table_args__ = (
        UniqueConstraint("carrier_id", "coverage_type", "version", name="uq_rate_table_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    carrier_id: Mapped[int] = mapped_column(ForeignKey("carriers.id"), index=True)
    coverage_type: Mapped[str] = mapped_column(String(8))  # "mtpl" | "casco"
    version: Mapped[int] = mapped_column(Integer, default=1)

    source_filename: Mapped[str | None] = mapped_column(String(256), default=None)
    source_format: Mapped[str | None] = mapped_column(String(8), default=None)  # xlsx|csv|pdf
    file_sha256: Mapped[str | None] = mapped_column(String(64), default=None, index=True)

    valid_from: Mapped[date | None] = mapped_column(Date, default=None)
    valid_to: Mapped[date | None] = mapped_column(Date, default=None)
    status: Mapped[str] = mapped_column(String(16), default="draft")

    uploaded_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), default=None)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    notes: Mapped[str | None] = mapped_column(Text, default=None)

    carrier: Mapped["Carrier"] = relationship(back_populates="rate_tables")
    components: Mapped[list["RateComponent"]] = relationship(
        back_populates="rate_table", cascade="all, delete-orphan"
    )


class RateComponent(Base):
    """A single normalized piece of a tariff: a base, a factor, or a loading.

    - component_type="base": `value` is a currency amount (MTPL) or, for Casco with
      value_kind="rate_of_base", a fraction applied to the vehicle market value.
    - component_type="factor": `value` is a multiplier (value_kind="multiplier").
    - component_type="loading": `value` is either a fixed amount (value_kind="amount")
      or a fraction of the running premium (value_kind="rate_of_base").

    Matching:
    - match_type="exact": compare `key_str` to the input's string form.
    - match_type="range": key_low <= input_value <= key_high (open-ended if a bound is NULL).
    - match_type="default": fallback when nothing else matches.
    Compound-key base rows (both key_low/high AND key_str set) cover non-separable matrices.
    """

    __tablename__ = "rate_components"
    __table_args__ = (
        Index("ix_rate_components_lookup", "rate_table_id", "factor_name", "component_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rate_table_id: Mapped[int] = mapped_column(ForeignKey("rate_tables.id"), index=True)

    component_type: Mapped[str] = mapped_column(String(8))   # base|factor|loading
    factor_name: Mapped[str | None] = mapped_column(String(32), default=None)
    match_type: Mapped[str] = mapped_column(String(8), default="exact")

    key_low: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), default=None)
    key_high: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), default=None)
    key_str: Mapped[str | None] = mapped_column(String(64), default=None)

    value: Mapped[Decimal] = mapped_column(Numeric(14, 4))
    value_kind: Mapped[str] = mapped_column(String(16), default="amount")
    priority: Mapped[int] = mapped_column(Integer, default=0)

    rate_table: Mapped["RateTable"] = relationship(back_populates="components")
