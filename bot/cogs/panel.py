from discord import app_commands, Interaction
from discord.ext import commands
from utils.view import PanelView, SuccessView


class Panel(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(name="패널", description="현재 채널에 연동 패널을 보냅니다.")
    @app_commands.guild_only()
    @app_commands.default_permissions(manage_guild=True)
    async def panel(self, interaction: Interaction):
        await interaction.channel.send(view=PanelView())
        await interaction.response.send_message(view=SuccessView("✅"), ephemeral=True, delete_after=3)


async def setup(bot):
    await bot.add_cog(Panel(bot))
