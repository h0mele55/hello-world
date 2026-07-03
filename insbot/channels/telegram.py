"""Telegram adapter.

Thin I/O translation only — all logic lives in ConversationService. Sending uses
the stdlib (urllib) so the adapter has no heavy dependency and is easy to host.

Wire-up (once you have a token from @BotFather):
    export INSBOT_TELEGRAM_TOKEN=123:abc
    # point Telegram at your public HTTPS webhook:
    curl "https://api.telegram.org/bot$INSBOT_TELEGRAM_TOKEN/setWebhook?url=https://YOURHOST/webhook/telegram"
"""
from __future__ import annotations

import json
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from insbot.channels.base import BotReply, OutboundSender
from insbot.conversation.service import START, ConversationService
from insbot.models.conversation import ConversationState
from insbot.models.user import User

API = "https://api.telegram.org/bot{token}/{method}"


class TelegramSender(OutboundSender):
    def __init__(self, token: str):
        self._token = token

    def send(self, channel_user_id: str, reply: BotReply) -> None:
        payload = {"chat_id": channel_user_id, "text": reply.text}
        if reply.quick_replies:
            payload["reply_markup"] = {
                "keyboard": [[{"text": qr}] for qr in reply.quick_replies],
                "resize_keyboard": True,
                "one_time_keyboard": True,
            }
        data = json.dumps(payload).encode("utf-8")
        url = API.format(token=self._token, method="sendMessage")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15).read()  # noqa: S310 (trusted URL)


def _get_or_create_user(session: Session, chat_id: str, name: str | None) -> User:
    user = session.execute(
        select(User).where(User.channel == "telegram", User.channel_user_id == chat_id)
    ).scalar_one_or_none()
    if user is None:
        user = User(channel="telegram", channel_user_id=chat_id, display_name=name)
        session.add(user)
        session.flush()
    return user


def _load_state(session: Session, user_id: int) -> ConversationState:
    st = session.execute(
        select(ConversationState).where(ConversationState.user_id == user_id)
    ).scalar_one_or_none()
    if st is None:
        st = ConversationState(user_id=user_id, state=START, context_json={})
        session.add(st)
        session.flush()
    return st


def handle_update(update: dict, session: Session, svc: ConversationService, sender: OutboundSender) -> None:
    """Process one Telegram update dict (already JSON-parsed)."""
    message = update.get("message") or update.get("edited_message")
    if not message:
        return
    chat_id = str(message["chat"]["id"])
    text = message.get("text", "")
    name = message.get("from", {}).get("first_name")

    user = _get_or_create_user(session, chat_id, name)
    st = _load_state(session, user.id)

    turn = svc.handle(st.state, st.context_json or {}, text)

    st.state = turn.state
    st.context_json = turn.context
    session.add(st)
    session.commit()

    sender.send(chat_id, turn.reply)
