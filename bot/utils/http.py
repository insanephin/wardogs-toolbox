from aiohttp import ClientSession, ClientTimeout
from utils.models import Ticket, TicketState, PanelServer, GuildServer, ReportInfo, ReportResult


class DashboardError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class DashboardClient(ClientSession):
    def __init__(self, base_url: str, secret: str):
        super().__init__(headers={"Authorization": f"Bearer {secret}"}, timeout=ClientTimeout(total=40))
        self.base_url = base_url.rstrip("/")

    async def _json(self, method: str, url: str, **kwargs):
        async with self.request(method, f"{self.base_url}{url}", **kwargs) as response:
            if 400 <= response.status < 500:
                body = await response.json(content_type=None)
                error = (body or {}).get("error") or {}
                raise DashboardError(response.status, error.get("code", ""), error.get("message", ""))
            response.raise_for_status()
            return await response.json()

    async def panel_server(self, guild_id: int, server_id: int | None = None) -> PanelServer:
        response = await self._json("POST", "/api/discord/panel", json={"guildId": str(guild_id), "serverId": server_id})
        return PanelServer.model_validate(response)

    async def guild_servers(self, guild_id: int) -> list[GuildServer]:
        response = await self._json("GET", f"/api/discord/guilds/{guild_id}/servers")
        return [GuildServer.model_validate(s) for s in response]

    async def create_ticket(self, server_id: int, discord_id: int, discord_name: str) -> Ticket:
        response = await self._json("POST", "/api/discord/tickets", json={"serverId": server_id, "discordId": str(discord_id), "discordName": discord_name})
        return Ticket.model_validate(response)

    async def wait_ticket(self, ticket: str, after: int) -> TicketState:
        response = await self._json("GET", f"/api/discord/tickets/{ticket}", params={"after": after})
        return TicketState.model_validate(response)

    async def report_info(self, server_id: int, discord_id: int) -> ReportInfo:
        response = await self._json("GET", "/api/discord/report", params={"serverId": server_id, "discordId": str(discord_id)})
        return ReportInfo.model_validate(response)

    async def create_report(self, server_id: int, discord_id: int, discord_name: str, fields: dict) -> ReportResult:
        payload = {"serverId": server_id, "discordId": str(discord_id), "discordName": discord_name, **fields}
        response = await self._json("POST", "/api/discord/reports", json=payload)
        return ReportResult.model_validate(response)

    async def upload_report_image(self, report_id: int, discord_id: int, data: bytes, content_type: str) -> None:
        await self._json("POST", f"/api/discord/reports/{report_id}/images", params={"discordId": str(discord_id)},
                         data=data, headers={"Content-Type": content_type})
