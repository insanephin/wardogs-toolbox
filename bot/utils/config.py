import os
from dataclasses import dataclass
from urllib.parse import urljoin


# Shares the dashboard's .env instead of a config.ini, so every secret lives in one file.
@dataclass(frozen=True)
class Config:
    discord_token: str
    rcon_url: str
    rcon_password: str
    db_path: str
    http_host: str
    http_port: int
    chzzk_client_id: str
    chzzk_client_secret: str
    chzzk_redirect_url: str
    steam_api_key: str
    steam_return_url: str


def load() -> Config:
    env = os.environ
    chzzk_redirect = env.get("CHZZK_REDIRECT_URL", "")
    return Config(
        discord_token=env.get("DISCORD_BOT_TOKEN", ""),
        rcon_url=env.get("RCON_URL", "").rstrip("/"),
        rcon_password=env.get("RCON_PASSWORD", ""),
        db_path=env.get("DB_PATH", "../data/dashboard.db"),
        http_host=env.get("BOT_HTTP_HOST", "127.0.0.1"),
        http_port=int(env.get("BOT_HTTP_PORT_INTERNAL", "8081")),
        chzzk_client_id=env.get("CHZZK_CLIENT_ID", ""),
        chzzk_client_secret=env.get("CHZZK_CLIENT_SECRET", ""),
        chzzk_redirect_url=chzzk_redirect,
        steam_api_key=env.get("STEAM_WEB_API_KEY", ""),
        # Defaults to a sibling of the Chzzk callback (.../callback/chzzk -> .../callback/steam).
        steam_return_url=env.get("STEAM_RETURN_URL") or (urljoin(chzzk_redirect, "steam") if chzzk_redirect else ""),
    )


config = load()
