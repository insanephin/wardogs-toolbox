import asyncio, logging, time
from typing import Callable
from discord import Interaction
from discord.ui import LayoutView
from discord.ext import commands
from configparser import ConfigParser
from utils.models import TicketState
from utils.view import ErrorView, SuccessView, VerifyView
from utils.http import DashboardClient


logger = logging.getLogger(__name__)
config = ConfigParser()
config.read("config.ini")


class Verify(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.client = DashboardClient(config['dashboard']['url'], config['dashboard']['secret'])
        guild_id = config['bot'].get('guild_id')
        self.guild_id = int(guild_id) if guild_id else None

    async def cog_unload(self):
        await self.client.close()

    async def _guard(self, interaction: Interaction) -> bool:
        if self.guild_id and interaction.guild_id != self.guild_id:
            await interaction.response.send_message(view=ErrorView("이 디스코드 서버에서는 인증할 수 없습니다."), ephemeral=True)
            return False
        return True

    async def start_streamer(self, interaction: Interaction):
        if not await self._guard(interaction):
            return
        try:
            ticket = await self.client.create_ticket(interaction.user.id, interaction.user.display_name)
        except Exception:
            logger.error("Failed to create verify ticket", exc_info=True)
            return await interaction.response.send_message(view=ErrorView("지금은 인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."), ephemeral=True)

        def render(state: TicketState) -> LayoutView:
            accounts = f"치지직 **{state.chzzk_name}** · 스팀 **{state.steam_name}**" if state.chzzk_name else f"스팀 **{state.steam_name}**"
            if state.result == "reserved":
                return SuccessView(f"{accounts}(으)로 화이트리스트 등록을 완료했습니다. 서버 접속 우선권이 적용되었습니다.")
            if state.result == "queued":
                return SuccessView(f"{accounts}(으)로 화이트리스트 등록을 완료했습니다. 게임 서버에 연결되는 대로 접속 우선권이 적용됩니다.")
            if state.done:
                return ErrorView("인증 링크가 만료되었습니다. 패널의 인증하기 버튼을 다시 눌러주세요.")
            if state.result == "taken":
                return VerifyView(ticket, state, error="방금 로그인한 계정은 이미 다른 계정과 연동되어 있습니다. 다른 계정으로 로그인하거나 관리자에게 문의해주세요.")
            return VerifyView(ticket, state)

        await interaction.response.send_message(view=VerifyView(ticket), ephemeral=True)
        self.bot.loop.create_task(self.watch(interaction, ticket.ticket, ticket.expires_at, render))

    async def watch(self, interaction: Interaction, ticket: str, expires_at: int, render: Callable[[TicketState], LayoutView]):
        after = 0
        while time.time() * 1000 < expires_at + 5000:
            try:
                state = await self.client.wait_ticket(ticket, after)
            except Exception:
                logger.warning("Ticket long poll failed, retrying", exc_info=True)
                await asyncio.sleep(5)
                continue
            if state.version <= after and not state.done:
                continue
            after = state.version
            try:
                await interaction.edit_original_response(view=render(state))
            except Exception:
                logger.warning("Failed to edit ticket reply", exc_info=True)
                return
            if state.done:
                return


async def setup(bot):
    await bot.add_cog(Verify(bot))
