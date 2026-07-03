"""Vehicles being insured."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from insbot.app.db import Base


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    reg_plate: Mapped[str | None] = mapped_column(String(16), default=None)
    vin: Mapped[str | None] = mapped_column(String(24), default=None)
    make: Mapped[str | None] = mapped_column(String(48), default=None)
    model: Mapped[str | None] = mapped_column(String(48), default=None)
    first_registration_date: Mapped[date | None] = mapped_column(Date, default=None)

    engine_power_kw: Mapped[int | None] = mapped_column(Integer, default=None)
    engine_cc: Mapped[int | None] = mapped_column(Integer, default=None)
    category: Mapped[str | None] = mapped_column(String(16), default=None)  # MPS category from талон
    seats: Mapped[int | None] = mapped_column(Integer, default=None)

    registration_region: Mapped[str | None] = mapped_column(String(8), default=None)  # област of registration
    market_value_bgn: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), default=None)  # Casco only

    # Provenance: "manual" | "ocr" | "eisoukr"
    data_source: Mapped[str] = mapped_column(String(16), default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
