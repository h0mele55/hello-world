"""Channel-agnostic conversation state machine for the MTPL quote flow.

Pure logic: `handle(state, context, text) -> (new_state, new_context, BotReply)`.
No ORM, no network. The compute step calls an injected `quoter` callable, so this
class is trivially unit-testable and reused verbatim by every channel adapter.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from insbot.channels.base import BotReply
from insbot.conversation import messages as M
from insbot.rating.schemas import Quote, RatingInput

Quoter = Callable[[RatingInput], list[Quote]]

# States
START = "START"
ASK_POWER = "ASK_POWER"
ASK_REGION = "ASK_REGION"
ASK_FIRST_REG_YEAR = "ASK_FIRST_REG_YEAR"
ASK_CATEGORY = "ASK_CATEGORY"
ASK_AGE = "ASK_AGE"
ASK_EXPERIENCE = "ASK_EXPERIENCE"
ASK_BONUS_MALUS = "ASK_BONUS_MALUS"
DONE = "DONE"

_CANCEL_WORDS = {"cancel", "отказ", "стоп", "/cancel"}
_RESTART_WORDS = {"start", "старт", "/start", "restart", "рестарт"}


@dataclass
class Turn:
    state: str
    context: dict
    reply: BotReply


def _int(text: str) -> int | None:
    try:
        return int(str(text).strip())
    except (ValueError, TypeError):
        return None


class ConversationService:
    def __init__(self, quoter: Quoter):
        self._quote = quoter

    def handle(self, state: str, context: dict, text: str) -> Turn:
        text = (text or "").strip()
        low = text.lower()
        context = dict(context or {})

        # Global intents win before state dispatch.
        if low in _CANCEL_WORDS:
            return Turn(START, {}, BotReply(M.CANCELLED))
        if low in _RESTART_WORDS or state in (START, "", DONE):
            return Turn(ASK_POWER, {}, BotReply(f"{M.WELCOME}\n\n{M.ASK_POWER}", expects="number"))

        handler = getattr(self, f"_on_{state.lower()}", None)
        if handler is None:
            # Unknown state → restart cleanly.
            return Turn(ASK_POWER, {}, BotReply(M.ASK_POWER, expects="number"))
        return handler(context, text)

    # --- per-state handlers ---
    def _on_ask_power(self, ctx, text) -> Turn:
        n = _int(text)
        if n is None or not (1 <= n <= 1000):
            return Turn(ASK_POWER, ctx, BotReply(M.INVALID_NUMBER, expects="number"))
        ctx["engine_power_kw"] = n
        return Turn(ASK_REGION, ctx, BotReply(M.ASK_REGION))

    def _on_ask_region(self, ctx, text) -> Turn:
        ctx["registration_region"] = text.upper()
        return Turn(ASK_FIRST_REG_YEAR, ctx, BotReply(M.ASK_FIRST_REG_YEAR, expects="number"))

    def _on_ask_first_reg_year(self, ctx, text) -> Turn:
        n = _int(text)
        if n is None or not (1950 <= n <= 2100):
            return Turn(ASK_FIRST_REG_YEAR, ctx, BotReply(M.INVALID_NUMBER, expects="number"))
        ctx["first_registration_year"] = n
        return Turn(ASK_CATEGORY, ctx, BotReply(M.ASK_CATEGORY,
                                                quick_replies=["B", "C", "motorcycle"], expects="choice"))

    def _on_ask_category(self, ctx, text) -> Turn:
        ctx["vehicle_category"] = text
        return Turn(ASK_AGE, ctx, BotReply(M.ASK_AGE, expects="number"))

    def _on_ask_age(self, ctx, text) -> Turn:
        n = _int(text)
        if n is None or not (16 <= n <= 120):
            return Turn(ASK_AGE, ctx, BotReply(M.INVALID_NUMBER, expects="number"))
        ctx["owner_age"] = n
        return Turn(ASK_EXPERIENCE, ctx, BotReply(M.ASK_EXPERIENCE, expects="number"))

    def _on_ask_experience(self, ctx, text) -> Turn:
        n = _int(text)
        if n is None or not (0 <= n <= 100):
            return Turn(ASK_EXPERIENCE, ctx, BotReply(M.INVALID_NUMBER, expects="number"))
        ctx["owner_experience_years"] = n
        return Turn(ASK_BONUS_MALUS, ctx, BotReply(M.ASK_BONUS_MALUS))

    def _on_ask_bonus_malus(self, ctx, text) -> Turn:
        ctx["bonus_malus_class"] = text
        return self._compute(ctx)

    def _compute(self, ctx) -> Turn:
        rating = RatingInput(
            coverage_type="mtpl",
            engine_power_kw=ctx["engine_power_kw"],
            registration_region=ctx["registration_region"],
            first_registration_year=ctx["first_registration_year"],
            vehicle_category=ctx["vehicle_category"],
            owner_age=ctx["owner_age"],
            owner_experience_years=ctx["owner_experience_years"],
            bonus_malus_class=ctx["bonus_malus_class"],
        )
        quotes = self._quote(rating)
        if not quotes:
            return Turn(DONE, {}, BotReply(f"{M.NO_QUOTES}\n{M.DONE_HINT}"))
        lines = [M.QUOTES_HEADER]
        for i, q in enumerate(quotes, 1):
            lines.append(f"{i}. {q.carrier_name}: {q.premium_bgn} лв.")
        lines.append("")
        lines.append(M.DONE_HINT)
        return Turn(DONE, {}, BotReply("\n".join(lines)))
