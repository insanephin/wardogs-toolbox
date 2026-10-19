from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from utils.config import config


# Same file as the dashboard, so it can join links against players.steam_id.
engine = create_async_engine(
    f"sqlite+aiosqlite:///{config.db_path}",
    echo=False,
)


@event.listens_for(engine.sync_engine, "connect")
def _pragmas(dbapi_conn, _):
    # The dashboard writes to this file too; wait for its lock instead of failing.
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


async_session = sessionmaker(
    engine,
    expire_on_commit=False,
    class_=AsyncSession,
    autoflush=True
)
