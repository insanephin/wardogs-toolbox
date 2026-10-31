import logging
from discord import app_commands, Interaction
from discord.ext import commands
from utils.http import DashboardError
from utils.view import WhitelistPanelView, PublicPanelView, SuccessView, ErrorView, UNREACHABLE


logger = logging.getLogger(__name__)


class Panel(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @property
    def client(self):
        return self.bot.get_cog("Verify").client

    @app_commands.command(name="패널", description="인증을 위한 패널 생성 명령어")
    @app_commands.rename(kind="종류", server="서버")
    @app_commands.describe(kind="화이트리스트: 접속 우선권 인증 / 일반: 서버 접속·신고", server="여러 서버를 관리할 경우 서버를 선택해주세요.")
    @app_commands.choices(kind=[
        app_commands.Choice(name="화이트리스트", value="whitelist"),
        app_commands.Choice(name="일반", value="public"),
    ])
    @app_commands.guild_only()
    @app_commands.default_permissions(manage_guild=True)
    async def panel(self, interaction: Interaction, kind: app_commands.Choice[str], server: int | None = None):
        try:
            target = await self.client.panel_server(interaction.guild_id, server)
        except DashboardError as e:
            return await interaction.response.send_message(view=ErrorView(e.message), ephemeral=True)
        except Exception:
            logger.error("Failed to resolve panel server", exc_info=True)
            return await interaction.response.send_message(view=ErrorView(UNREACHABLE), ephemeral=True)

        if kind.value == "whitelist":
            view = WhitelistPanelView(target.id, target.name)
        else:
            view = PublicPanelView(target.id, target.name, target.join_url)
        await interaction.channel.send(view=view)
        await interaction.response.send_message(view=SuccessView("✅"), ephemeral=True, delete_after=3)

    @panel.autocomplete("server")
    async def server_autocomplete(self, interaction: Interaction, current: str) -> list[app_commands.Choice[int]]:
        try:
            servers = await self.client.guild_servers(interaction.guild_id)
        except Exception:
            logger.warning("Failed to list guild servers", exc_info=True)
            return []
        return [app_commands.Choice(name=s.name[:100], value=s.id) for s in servers if current.lower() in s.name.lower()][:25]


async def setup(bot):
    await bot.add_cog(Panel(bot))
