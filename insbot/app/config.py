"""Application settings.

Uses pydantic-settings so every value can be overridden by an environment
variable (or a local .env file) without touching code. This keeps secrets
(bot tokens, DB URLs) out of the repo.
"""
from __future__ import annotations

from functools import lru_cache

try:
    # pydantic-settings is the runtime dependency; fall back to a tiny shim so
    # the rating core and tests can run before the full stack is installed.
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class Settings(BaseSettings):
        model_config = SettingsConfigDict(env_prefix="INSBOT_", env_file=".env", extra="ignore")

        # Database — SQLite file by default, swap to a postgres:// URL later.
        database_url: str = "sqlite:///insbot.db"

        # Which vehicle-data provider is active: "manual" | "ocr" | "eisoukr".
        vehicle_source: str = "manual"

        # Telegram bot token (empty until you create a bot with @BotFather).
        telegram_token: str = ""

        # Timezone for the daily reminder job.
        timezone: str = "Europe/Sofia"

        # Salt used when hashing ЕГН before storage (GDPR). Override in prod.
        egn_hash_salt: str = "change-me-in-production"

except Exception:  # pragma: no cover - shim path only
    from dataclasses import dataclass

    @dataclass
    class Settings:  # type: ignore[no-redef]
        database_url: str = "sqlite:///insbot.db"
        vehicle_source: str = "manual"
        telegram_token: str = ""
        timezone: str = "Europe/Sofia"
        egn_hash_salt: str = "change-me-in-production"


@lru_cache
def get_settings() -> "Settings":
    return Settings()
