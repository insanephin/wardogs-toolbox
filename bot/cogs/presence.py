import logging
from discord import Activity, ActivityType
from discord.ext import commands, tasks
from utils.config import config
from utils.http import RconClient


logger = logging.getLogger(__name__)

# Shown until RCON answers, or whenever the game server is unreachable.
FALLBACK_NAME = "WARDOGS"


class Presence(commands.Cog):
    """Keeps the bot's activity set to the game server's name from RCON."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.rcon = RconClient(config.rcon_url, config.rcon_password)
        self.current: str | None = None

    async def cog_load(self):
        self.refresh.start()

    async def cog_unload(self):
        self.refresh.cancel()
        await self.rcon.close()

    @tasks.loop(minutes=1)
    async def refresh(self):
        name = FALLBACK_NAME
        if config.rcon_url:
            try:
                name = (await self.rcon.status()).serverName or FALLBACK_NAME
            except Exception as e:
                logger.warning("RCON status failed: %s", e)
        # Presence updates are rate limited, so only send when the name actually changes.
        if name != self.current:
            await self.bot.change_presence(activity=Activity(name=name, type=ActivityType.playing))
            self.current = name

    @refresh.before_loop
    async def before_refresh(self):
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot):
    await bot.add_cog(Presence(bot))
