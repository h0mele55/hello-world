"""Reminder job: correct milestones fire, and never twice."""
from __future__ import annotations

from datetime import date, timedelta

from insbot.channels.base import BotReply
from insbot.models import enums as E
from insbot.models.policy import Policy
from insbot.models.user import User
from insbot.models.vehicle import Vehicle
from insbot.reminders.job import run_expiry_reminders


class _CapturingSender:
    def __init__(self):
        self.sent: list[tuple[str, BotReply]] = []

    def send(self, channel_user_id: str, reply: BotReply) -> None:
        self.sent.append((channel_user_id, reply))


def _make_policy(session, expiry: date) -> None:
    u = User(channel="telegram", channel_user_id=f"u{expiry.isoformat()}")
    session.add(u)
    session.flush()
    v = Vehicle(user_id=u.id)
    session.add(v)
    session.flush()
    p = Policy(user_id=u.id, vehicle_id=v.id, coverage_type=E.MTPL,
               status=E.POLICY_ACTIVE, expiry_date=expiry, policy_number="X1")
    session.add(p)
    session.commit()


def test_only_milestone_days_fire(session):
    today = date(2026, 6, 1)
    _make_policy(session, today + timedelta(days=30))  # fires
    _make_policy(session, today + timedelta(days=14))  # fires
    _make_policy(session, today + timedelta(days=1))   # fires
    _make_policy(session, today + timedelta(days=7))   # NOT a milestone
    sender = _CapturingSender()
    n = run_expiry_reminders(session, sender, today=today)
    assert n == 3
    assert len(sender.sent) == 3


def test_no_duplicate_sends_on_rerun(session):
    today = date(2026, 6, 1)
    _make_policy(session, today + timedelta(days=14))
    sender = _CapturingSender()
    assert run_expiry_reminders(session, sender, today=today) == 1
    # Same day, job runs again (e.g. process restart) → no second message.
    assert run_expiry_reminders(session, sender, today=today) == 0
    assert len(sender.sent) == 1
