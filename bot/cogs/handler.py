import logging
from discord import Interaction
from discord.app_commands import AppCommandError, CheckFailure
from discord.ext import commands
from utils.view import send_error


logger = logging.getLogger(__name__)


class Handler(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        bot.tree.on_error = self.app_error_handler

    @commands.Cog.listener("on_command_error")
    async def error_handler(self, ctx, error):
        if isinstance(error, (commands.CommandNotFound, commands.CheckFailure)):
            return
        if isinstance(error, commands.MissingPermissions):
            return await ctx.message.add_reaction("❌")
        logger.error("Unhandled command error", exc_info=error)

    async def app_error_handler(self, interaction: Interaction, error: AppCommandError):
        if not isinstance(error, CheckFailure):
            logger.error("Unhandled app command error", exc_info=error)
        await send_error(interaction, "알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요.")


async def setup(bot):
    await bot.add_cog(Handler(bot))
