import html, logging, secrets, time
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse
from aiohttp import web
from discord import app_commands, Interaction, HTTPException, NotFound
from discord.ext import commands
from sqlalchemy import select
from utils.config import config
from utils.http import ChzzkClient, SteamClient, OAuthError, PROVIDER_ERROR
from utils.database import async_session, AccountLink
from utils.view import ErrorView, SuccessView, LinkPanelView, LinkStartView, LinkStatusView
from utils.view.link import PROVIDERS


logger = logging.getLogger(__name__)

# Discord lets an interaction's reply be edited for 15 minutes; stay under that so the
# ephemeral message can always be turned into the result.
STATE_TTL_SEC = 10 * 60

LINK_EXPIRED = "만료되었거나 이미 사용된 링크입니다. 패널의 버튼을 다시 눌러주세요."
LINK_CANCELLED = "{provider} 로그인이 취소되었습니다."
LINK_TAKEN = "이 {provider} 계정은 이미 다른 디스코드 계정에 연동되어 있습니다."
LINK_SUCCESS = "{provider} 연동 완료: {name}"


@dataclass
class Pending:
    provider: str
    user_id: int
    interaction: Interaction
    expires_at: float


class Link(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.chzzk = ChzzkClient(config.chzzk_client_id, config.chzzk_client_secret, config.chzzk_redirect_url)
        self.steam = SteamClient(config.steam_api_key, config.steam_return_url)
        # state -> Pending. In memory on purpose: a restart only cancels links in progress.
        self.pending: dict[str, Pending] = {}
        self.runner: web.AppRunner | None = None

    async def cog_load(self):
        app = web.Application()
        if config.chzzk_redirect_url:
            app.router.add_get(urlparse(config.chzzk_redirect_url).path, self.chzzk_callback)
        if config.steam_return_url:
            app.router.add_get(urlparse(config.steam_return_url).path, self.steam_callback)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, config.http_host, config.http_port).start()
        logger.info("OAuth callback server on %s:%s", config.http_host, config.http_port)

    async def cog_unload(self):
        if self.runner:
            await self.runner.cleanup()
        await self.chzzk.close()
        await self.steam.close()

    @app_commands.command(name="연동패널", description="이 채널에 계정 연동 패널을 생성합니다.")
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    @app_commands.checks.has_permissions(administrator=True)
    @app_commands.rename(message_id="메시지id")
    @app_commands.describe(message_id="새로 만들지 않고 이 채널에 있는 기존 패널 메시지를 갱신합니다.")
    async def link_panel(self, interaction: Interaction, message_id: str = None):
        view = LinkPanelView()
        if message_id:
            try:
                message = await interaction.channel.fetch_message(int(message_id))
                await message.edit(view=view)
            except (ValueError, NotFound):
                return await interaction.response.send_message(view=ErrorView("이 채널에서 해당 메시지를 찾을 수 없습니다."), ephemeral=True)
        else:
            await interaction.channel.send(view=view)
        await interaction.response.send_message(view=SuccessView("패널을 생성했습니다."), ephemeral=True)

    def client_for(self, provider: str) -> ChzzkClient | SteamClient:
        return self.chzzk if provider == "chzzk" else self.steam

    async def start_link(self, interaction: Interaction, provider: str):
        client = self.client_for(provider)
        if not client.configured:
            return await interaction.response.send_message(view=ErrorView("아직 설정되지 않은 서비스입니다. 관리자에게 문의해주세요."), ephemeral=True)

        now = time.monotonic()
        # Drop expired states and any earlier attempt by this user for the same service.
        self.pending = {
            s: p for s, p in self.pending.items()
            if p.expires_at > now and not (p.user_id == interaction.user.id and p.provider == provider)
        }
        state = secrets.token_urlsafe(24)
        self.pending[state] = Pending(provider, interaction.user.id, interaction, now + STATE_TTL_SEC)

        view = LinkStartView(provider, client.authorize_url(state), STATE_TTL_SEC // 60)
        await interaction.response.send_message(view=view, ephemeral=True)

    async def show_status(self, interaction: Interaction):
        async with async_session() as session:
            row = await session.get(AccountLink, interaction.user.id)
        await interaction.response.send_message(view=LinkStatusView(row), ephemeral=True)

    async def unlink(self, interaction: Interaction, provider: str):
        async with async_session() as session:
            async with session.begin():
                row = await session.get(AccountLink, interaction.user.id)
                if row:
                    if provider == "chzzk":
                        row.chzzk_channel_id = row.chzzk_name = row.chzzk_linked_at = None
                    else:
                        row.steam_id = row.steam_name = row.steam_linked_at = None
        await interaction.response.edit_message(view=LinkStatusView(row))

    def take_state(self, state: str | None, provider: str) -> Pending:
        # pop: a state is single-use, so a leaked callback URL cannot be replayed.
        pending = self.pending.pop(state or "", None)
        if not pending or pending.provider != provider or pending.expires_at < time.monotonic():
            raise OAuthError(LINK_EXPIRED)
        return pending

    async def save(self, pending: Pending, provider: str, external_id: str, name: str):
        discord_id = pending.user_id
        id_col = AccountLink.chzzk_channel_id if provider == "chzzk" else AccountLink.steam_id
        async with async_session() as session:
            async with session.begin():
                owner = await session.scalar(select(AccountLink.discord_id).where(id_col == external_id))
                if owner is not None and owner != discord_id:
                    raise OAuthError(LINK_TAKEN)

                row = await session.get(AccountLink, discord_id)
                if row is None:
                    row = AccountLink(discord_id=discord_id)
                    session.add(row)
                row.discord_name = pending.interaction.user.name
                now = datetime.now(timezone.utc)
                if provider == "chzzk":
                    row.chzzk_channel_id, row.chzzk_name, row.chzzk_linked_at = external_id, name, now
                else:
                    row.steam_id, row.steam_name, row.steam_linked_at = external_id, name, now

    async def finish(self, pending: Pending | None, provider: str, ok: bool, template: str, **fmt) -> web.Response:
        """Shows the result both in Discord (the ephemeral message) and in the browser tab."""
        message = template.format(provider=PROVIDERS[provider], **fmt)
        if pending:
            try:
                view = SuccessView(f"{message}\n-# 브라우저 창은 닫아도 됩니다.") if ok else ErrorView(message)
                await pending.interaction.edit_original_response(view=view)
            except HTTPException:
                logger.info("Could not edit link message for user %s", pending.user_id)

        if ok:
            title, guide = "연동이 완료되었습니다", "이제 이 페이지를 닫아도 됩니다."
        else:
            title, guide = "연동하지 못했습니다", "이 페이지를 닫고 디스코드 패널에서 다시 시도해주세요."
        page = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WARDOGS 계정 연동</title>
<style>body{{font-family:system-ui,sans-serif;background:#1e1f22;color:#f2f3f5;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}}
main{{max-width:420px;width:100%;text-align:center;background:#2b2d31;border-radius:12px;padding:32px 24px;box-sizing:border-box}}
.icon{{font-size:48px;line-height:1}}h1{{font-size:22px;margin:16px 0 8px}}.detail{{color:#b5bac1;margin:0 0 24px;word-break:break-all}}
.guide{{font-size:17px;font-weight:600;margin:0;padding:12px;border-radius:8px;background:{'#1f3b2c' if ok else '#3b1f22'}}}</style></head>
<body><main><div class="icon">{'✅' if ok else '❌'}</div><h1>{title}</h1>
<p class="detail">{html.escape(message)}</p><p class="guide">{guide}</p></main></body></html>"""
        return web.Response(text=page, content_type="text/html", status=200 if ok else 400)

    async def chzzk_callback(self, request: web.Request) -> web.Response:
        pending = None
        try:
            pending = self.take_state(request.query.get("state"), "chzzk")
            code = request.query.get("code")
            if not code:
                raise OAuthError(LINK_CANCELLED)
            token = await self.chzzk.exchange(code, request.query["state"])
            try:
                user = await self.chzzk.me(token)
            finally:
                await self.chzzk.revoke(token)
            await self.save(pending, "chzzk", user.channelId, user.channelName)
            return await self.finish(pending, "chzzk", True, LINK_SUCCESS, name=user.channelName)
        except OAuthError as e:
            return await self.finish(pending, "chzzk", False, str(e))
        except Exception:
            logger.exception("Chzzk callback failed")
            return await self.finish(pending, "chzzk", False, PROVIDER_ERROR)

    async def steam_callback(self, request: web.Request) -> web.Response:
        pending = None
        try:
            pending = self.take_state(request.query.get("state"), "steam")
            if request.query.get("openid.mode") == "cancel":
                raise OAuthError(LINK_CANCELLED)
            steam_id = await self.steam.verify(dict(request.query))
            player = await self.steam.player(steam_id)
            name = player.personaname if player else steam_id
            await self.save(pending, "steam", steam_id, name)
            return await self.finish(pending, "steam", True, LINK_SUCCESS, name=name)
        except OAuthError as e:
            return await self.finish(pending, "steam", False, str(e))
        except Exception:
            logger.exception("Steam callback failed")
            return await self.finish(pending, "steam", False, PROVIDER_ERROR)


async def setup(bot: commands.Bot):
    await bot.add_cog(Link(bot))
