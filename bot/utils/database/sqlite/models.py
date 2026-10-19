from sqlalchemy import BigInteger, Column, String, DateTime
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


# The dashboard (server/store.js) creates the same table; keep the two definitions in step.
class AccountLink(Base):
    __tablename__ = 'account_links'

    discord_id = Column(BigInteger, primary_key=True)
    # Shown in the dashboard; refreshed on every link since usernames can change.
    discord_name = Column(String, nullable=True)
    # unique: one Steam account or Chzzk channel can belong to only one Discord user.
    steam_id = Column(String, unique=True, nullable=True)
    steam_name = Column(String, nullable=True)
    steam_linked_at = Column(DateTime(timezone=True), nullable=True)
    chzzk_channel_id = Column(String, unique=True, nullable=True)
    chzzk_name = Column(String, nullable=True)
    chzzk_linked_at = Column(DateTime(timezone=True), nullable=True)
