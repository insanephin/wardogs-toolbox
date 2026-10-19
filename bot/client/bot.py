import os, logging
from discord import Intents
from discord.ext import commands
from utils.database import engine, Base
from utils.view import LinkPanelView


logger = logging.getLogger(__name__)

# Slash commands and buttons only; no privileged intents needed.
intents = Intents.default()


class Bot(commands.Bot):
    def __init__(self):
        super().__init__(
            help_command=None,
            command_prefix=commands.when_mentioned,
            intents=intents,
        )

    async def setup_hook(self):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
                # create_all never adds columns to a table that already exists.
                cols = [r[1] for r in (await conn.exec_driver_sql("PRAGMA table_info(account_links)")).all()]
                if "discord_name" not in cols:
                    await conn.exec_driver_sql("ALTER TABLE account_links ADD COLUMN discord_name VARCHAR")

            for ext in os.listdir("cogs"):
                if ext.endswith(".py"):
                    await self.load_extension(f"cogs.{ext[:-3]}")
        except Exception:
            logger.exception("Bot setup failed")

        await self.tree.sync()
        self.add_view(LinkPanelView())
