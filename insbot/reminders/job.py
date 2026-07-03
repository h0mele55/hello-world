"""Expiry-reminder job.

Design: ONE daily job (not one timer per policy). It asks "which policies expire in
exactly 30 / 14 / 1 days?" and sends each once. Dedupe is structural — a UNIQUE
(policy_id, milestone) row in reminder_log means a double-run can't double-send.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Callable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from insbot.channels.base import BotReply, OutboundSender
from insbot.models import enums as E
from insbot.models.policy import Policy, ReminderLog
from insbot.models.user import User

MILESTONES = E.REMINDER_MILESTONES


def _message_for(policy: Policy, days: int) -> BotReply:
    when = "утре" if days == 1 else f"след {days} дни"
    return BotReply(
        f"Напомняне: застраховката за автомобил (полица {policy.policy_number or '—'}) "
        f"изтича {when} на {policy.expiry_date}. Желаете ли нова оферта? Напишете 'старт'."
    )


def run_expiry_reminders(
    session: Session,
    sender: OutboundSender,
    today: date | None = None,
) -> int:
    """Send due reminders. Returns how many messages were sent (for logging/tests)."""
    today = today or date.today()
    sent = 0
    for days in MILESTONES:
        target = today + timedelta(days=days)
        stmt = (
            select(Policy, User)
            .join(User, Policy.user_id == User.id)
            .where(Policy.status == E.POLICY_ACTIVE, Policy.expiry_date == target)
        )
        for policy, user in session.execute(stmt).all():
            # Claim the (policy, milestone) slot first; if it already exists, skip.
            log = ReminderLog(policy_id=policy.id, milestone=days)
            session.add(log)
            try:
                session.flush()
            except IntegrityError:
                session.rollback()
                continue
            sender.send(user.channel_user_id, _message_for(policy, days))
            sent += 1
    session.commit()
    return sent


def schedule(scheduler, session_factory, sender, tz: str = "Europe/Sofia") -> None:
    """Register the daily job on an APScheduler instance (called from app startup)."""
    from apscheduler.triggers.cron import CronTrigger

    def _tick():
        with session_factory() as s:
            run_expiry_reminders(s, sender)

    scheduler.add_job(_tick, CronTrigger(hour=9, minute=0, timezone=tz), id="expiry_reminders",
                      replace_existing=True)
