import logging
from discord import Interaction
from discord.app_commands import AppCommandError, MissingPermissions
from discord.ext import commands


logger = logging.getLogger(__name__)


class Handler(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        bot.tree.on_error = self.app_command_error

    async def app_command_error(self, interaction: Interaction, error: AppCommandError):
        if isinstance(error, MissingPermissions):
            message = "관리자 권한이 필요합니다."
        else:
            logger.error("Unhandled app command error", exc_info=error)
            message = "오류가 발생했습니다. 잠시 후 다시 시도해주세요."

        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Handler(bot))
