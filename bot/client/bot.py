import os, logging
from discord import Intents, Activity, ActivityType, Object
from discord.ext import commands
from configparser import ConfigParser
from utils.view import StreamerButton


logger = logging.getLogger(__name__)
config = ConfigParser()
config.read("config.ini")

intents = Intents.default()

class Bot(commands.Bot):
    def __init__(self, prefix: str):
        super().__init__(
            help_command=None,
            command_prefix=prefix,
            intents=intents,
        )

    async def setup_hook(self):
        try:
            for ext in os.listdir("cogs"):
                if ext.endswith(".py"):
                    await self.load_extension(f"cogs.{ext[:-3]}")
        except Exception:
            logger.error("Failed to load extensions", exc_info=True)

        self.add_dynamic_items(StreamerButton)

        guild_id = config['bot'].get('guild_id')
        if guild_id:
            guild = Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self):
        game = Activity(name="WARDOGS", type=ActivityType.playing)
        await self.change_presence(activity=game)
