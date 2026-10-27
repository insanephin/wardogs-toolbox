import logging
from discord import app_commands, Interaction
from discord.ext import commands
from utils.view import PanelView, SuccessView, ErrorView


logger = logging.getLogger(__name__)


class Panel(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @property
    def client(self):
        return self.bot.get_cog("Verify").client

    @app_commands.command(name="패널", description="현재 채널에 연동 패널을 보냅니다.")
    @app_commands.rename(server="서버")
    @app_commands.describe(server="패널을 연결할 서버 (관리자 이상인 서버만 고를 수 있습니다)")
    @app_commands.guild_only()
    @app_commands.default_permissions(manage_guild=True)
    async def panel(self, interaction: Interaction, server: str):
        try:
            result = await self.client.admin_servers(interaction.user.id)
        except Exception:
            logger.error("Failed to load admin servers", exc_info=True)
            return await interaction.response.send_message(view=ErrorView("지금은 대시보드에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."), ephemeral=True)

        if not result.linked:
            return await interaction.response.send_message(view=ErrorView("대시보드 계정 설정에서 디스코드를 먼저 연동해주세요."), ephemeral=True)
        target = next((s for s in result.servers if str(s.id) == server), None)
        if not target:
            return await interaction.response.send_message(view=ErrorView("관리자 이상 권한이 있는 서버만 고를 수 있습니다. 목록에서 서버를 선택해주세요."), ephemeral=True)

        await interaction.channel.send(view=PanelView(target.id, target.name))
        await interaction.response.send_message(view=SuccessView("✅"), ephemeral=True, delete_after=3)

    @panel.autocomplete("server")
    async def server_autocomplete(self, interaction: Interaction, current: str) -> list[app_commands.Choice[str]]:
        try:
            result = await self.client.admin_servers(interaction.user.id)
        except Exception:
            logger.warning("Failed to load admin servers for autocomplete", exc_info=True)
            return []
        query = current.strip().lower()
        servers = [s for s in result.servers if query in s.name.lower() or query == str(s.id)]
        return [app_commands.Choice(name=f"#{s.id} {s.name}"[:100], value=str(s.id)) for s in servers[:25]]


async def setup(bot):
    await bot.add_cog(Panel(bot))
