"""Stored policies and the reminder dedupe log."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from insbot.app.db import Base


class Policy(Base):
    __tablename__ = "policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"))
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("owners.id"), default=None)
    carrier_id: Mapped[int | None] = mapped_column(ForeignKey("carriers.id"), default=None)

    coverage_type: Mapped[str] = mapped_column(String(8))
    policy_number: Mapped[str | None] = mapped_column(String(48), default=None)
    premium_total_bgn: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), default=None)
    installments: Mapped[int | None] = mapped_column(Integer, default=None)

    start_date: Mapped[date | None] = mapped_column(Date, default=None)
    expiry_date: Mapped[date | None] = mapped_column(Date, default=None, index=True)

    bonus_malus_class: Mapped[str | None] = mapped_column(String(8), default=None)
    status: Mapped[str] = mapped_column(String(16), default="quoted")
    computed_breakdown_json: Mapped[dict | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    reminders: Mapped[list["ReminderLog"]] = relationship(back_populates="policy")


class ReminderLog(Base):
    """One row per (policy, milestone). The unique constraint IS the dedupe:
    a second send attempt for the same milestone hits an integrity error."""

    __tablename__ = "reminder_log"
    __table_args__ = (
        UniqueConstraint("policy_id", "milestone", name="uq_reminder_policy_milestone"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    policy_id: Mapped[int] = mapped_column(ForeignKey("policies.id"), index=True)
    milestone: Mapped[int] = mapped_column(Integer)  # 30 | 14 | 1
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    policy: Mapped["Policy"] = relationship(back_populates="reminders")
