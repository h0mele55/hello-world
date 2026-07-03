"""Channel-neutral message contract.

The conversation core only ever produces `BotReply`s. Each channel adapter
(Telegram, later Viber) translates a BotReply into that platform's API calls and
translates inbound platform events into plain text/media for the core. Keeping this
boundary strict is what lets us add Viber later without touching any logic.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class BotReply:
    text: str
    quick_replies: list[str] = field(default_factory=list)  # rendered as buttons or plain text
    expects: str = "text"                                    # "text"|"number"|"choice"|"photo"


class OutboundSender(Protocol):
    """Implemented by each channel adapter; also used by the reminder job."""

    def send(self, channel_user_id: str, reply: BotReply) -> None:
        ...
