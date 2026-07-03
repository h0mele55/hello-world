"""Shared test fixtures: a fresh in-memory SQLite DB per test."""
from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from insbot.app.db import Base, make_engine


@pytest.fixture()
def session() -> Session:
    import insbot.models  # noqa: F401  (register all tables)

    engine = make_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as s:
        yield s
