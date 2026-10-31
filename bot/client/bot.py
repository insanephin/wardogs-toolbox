import os, logging
from discord import Intents, Activity, ActivityType
from discord.ext import commands
from urllib.parse import urlparse
from utils.view import StreamerButton, ReportButton


logger = logging.getLogger(__name__)


class Bot(commands.Bot):
    def __init__(self, prefix: str):
        super().__init__(
            help_command=None,
            command_prefix=prefix,
            intents=Intents.default(),
        )

    async def setup_hook(self):
        await self.load_extension("jishaku")
        try:
            for ext in os.listdir("cogs"):
                if ext.endswith(".py"):
                    await self.load_extension(f"cogs.{ext[:-3]}")
        except Exception:
            logger.error("Failed to load extensions", exc_info=True)

        self.add_dynamic_items(StreamerButton, ReportButton)

    async def on_ready(self):
        host = urlparse(os.environ.get("PUBLIC_URL", "")).hostname or "wardogs"
        rpc = Activity(name=host, type=ActivityType.watching)
        await self.change_presence(activity=rpc)
