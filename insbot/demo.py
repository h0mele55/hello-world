"""Runnable demo — see the whole thing work with no Telegram/hosting needed.

    python -m insbot.demo

Creates an in-memory DB, seeds two demo carriers, runs a scripted chat, and prints
the ranked quotes exactly as a user would receive them.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from insbot.app.db import Base, make_engine
from insbot.conversation.service import START, ConversationService
from insbot.rating.engine import compute_quotes
from insbot.seed import seed_demo


def main() -> None:
    import insbot.models  # noqa: F401  (register tables)

    engine = make_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        seed_demo(session)
        svc = ConversationService(lambda ri: compute_quotes(ri, session))

        scripted = ["старт", "90", "SOF", "2018", "B", "30", "8", "0"]
        state, ctx = START, {}
        print("=== Demo chat (scripted) ===")
        for text in scripted:
            turn = svc.handle(state, ctx, text)
            state, ctx = turn.state, turn.context
            print(f"\nUser: {text}")
            print(f"Bot : {turn.reply.text}")
        print("\n=== end ===")


if __name__ == "__main__":
    main()
