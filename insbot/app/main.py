"""FastAPI app: Telegram webhook + daily reminder scheduler.

Run locally:
    export INSBOT_TELEGRAM_TOKEN=...           # from @BotFather
    uvicorn insbot.app.main:app --host 0.0.0.0 --port 8000
Then expose port 8000 over HTTPS (a tunnel for dev, a real host for prod) and
register the webhook (see insbot/channels/telegram.py).
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from insbot.app.config import get_settings
from insbot.app.db import SessionLocal, create_all
from insbot.channels.telegram import TelegramSender, handle_update
from insbot.conversation.service import ConversationService
from insbot.rating.engine import compute_quotes


def _build_service_and_sender():
    settings = get_settings()
    sender = TelegramSender(settings.telegram_token)

    def quoter_factory(session):
        return ConversationService(lambda ri: compute_quotes(ri, session))

    return quoter_factory, sender


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev convenience: ensure tables exist. In production use Alembic migrations.
    create_all()

    scheduler = None
    try:
        from apscheduler.schedulers.background import BackgroundScheduler

        from insbot.reminders.job import schedule

        settings = get_settings()
        _, sender = _build_service_and_sender()
        scheduler = BackgroundScheduler()
        schedule(scheduler, SessionLocal, sender, tz=settings.timezone)
        scheduler.start()
    except Exception as exc:  # pragma: no cover - scheduler optional in dev
        app.state.scheduler_error = str(exc)

    yield

    if scheduler is not None:
        scheduler.shutdown(wait=False)


app = FastAPI(title="Insurance Assistant Bot", lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/webhook/telegram")
async def telegram_webhook(request: Request):
    update = await request.json()
    quoter_factory, sender = _build_service_and_sender()
    with SessionLocal() as session:
        svc = quoter_factory(session)
        handle_update(update, session, svc, sender)
    return {"ok": True}
