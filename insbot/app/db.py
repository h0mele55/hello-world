"""Database engine and session factory.

One SQLAlchemy 2.0 declarative Base for all models. SQLite now; the only thing
that changes for Postgres later is the URL in settings (plus running Alembic).
"""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from insbot.app.config import get_settings


class Base(DeclarativeBase):
    """Shared declarative base for every ORM model."""


def make_engine(url: str | None = None):
    settings = get_settings()
    db_url = url or settings.database_url
    # check_same_thread only matters for SQLite; harmless to pass conditionally.
    connect_args = {"check_same_thread": False} if db_url.startswith("sqlite") else {}
    return create_engine(db_url, future=True, connect_args=connect_args)


# Module-level engine/session for the app. Tests build their own in-memory ones.
engine = make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def create_all(target_engine=None) -> None:
    """Create tables directly (used by the demo seed and tests).

    Production uses Alembic migrations instead of this.
    """
    # Import models for their side effect of registering on Base.metadata.
    import insbot.models  # noqa: F401

    Base.metadata.create_all(target_engine or engine)
