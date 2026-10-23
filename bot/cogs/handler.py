import logging
from discord import Interaction
from discord.app_commands import AppCommandError, CheckFailure
from discord.ext import commands
from utils.view import ErrorView


logger = logging.getLogger(__name__)


class Handler(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        bot.tree.on_error = self.app_error_handler

    @commands.Cog.listener("on_command_error")
    async def error_handler(self, ctx, error):
        if isinstance(error, (commands.CommandNotFound, commands.CheckFailure)):
            return
        elif isinstance(error, commands.MissingPermissions):
            return await ctx.message.add_reaction("❌")
        else:
            logger.error("Unhandled command error", exc_info=error)

    async def app_error_handler(self, interaction: Interaction, error: AppCommandError):
        if not isinstance(error, CheckFailure):
            logger.error("Unhandled app command error", exc_info=error)
        view = ErrorView("알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요.")
        if interaction.response.is_done():
            await interaction.edit_original_response(view=view)
        else:
            await interaction.response.send_message(view=view, ephemeral=True)

async def setup(bot):
    await bot.add_cog(Handler(bot))
