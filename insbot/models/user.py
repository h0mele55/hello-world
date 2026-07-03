"""End users and the owner/driver profiles they manage."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from insbot.app.db import Base


class User(Base):
    """A person chatting with the bot on a given channel.

    Identity is (channel, channel_user_id) — the platform's own user id — so the
    same human on Telegram and Viber is two rows, which is fine and simple.
    """

    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("channel", "channel_user_id", name="uq_user_channel"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    channel: Mapped[str] = mapped_column(String(16))          # "telegram" | "viber"
    channel_user_id: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(128), default=None)
    phone: Mapped[str | None] = mapped_column(String(32), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    owners: Mapped[list["Owner"]] = relationship(back_populates="user")


class Owner(Base):
    """An owner/driver whose attributes feed rating.

    Separate from User because one user often manages policies for several people
    (spouse, kids), and owner age/experience are pricing inputs, not auth identity.
    Never store a raw ЕГН — only a salted hash, for dedupe under GDPR.
    """

    __tablename__ = "owners"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    full_name: Mapped[str | None] = mapped_column(String(128), default=None)
    egn_hash: Mapped[str | None] = mapped_column(String(64), default=None, index=True)
    birth_date: Mapped[date | None] = mapped_column(Date, default=None)
    driving_license_date: Mapped[date | None] = mapped_column(Date, default=None)
    residence_region: Mapped[str | None] = mapped_column(String(8), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="owners")
