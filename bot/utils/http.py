from aiohttp import ClientSession, ClientTimeout
from utils.models import Ticket, TicketState, AdminServers


class DashboardClient(ClientSession):
    def __init__(self, base_url: str, secret: str):
        super().__init__(headers={"Authorization": f"Bearer {secret}"}, timeout=ClientTimeout(total=40))
        self.base_url = base_url.rstrip("/")

    async def _json(self, method: str, url: str, **kwargs):
        async with self.request(method, f"{self.base_url}{url}", **kwargs) as response:
            response.raise_for_status()
            return await response.json()

    async def admin_servers(self, discord_id: int) -> AdminServers:
        response = await self._json("GET", "/api/discord/servers", params={"discordId": str(discord_id)})
        return AdminServers.model_validate(response)

    async def create_ticket(self, server_id: int, discord_id: int, discord_name: str) -> Ticket:
        response = await self._json("POST", "/api/discord/tickets", json={"serverId": server_id, "discordId": str(discord_id), "discordName": discord_name})
        return Ticket.model_validate(response)

    async def wait_ticket(self, ticket: str, after: int) -> TicketState:
        response = await self._json("GET", f"/api/discord/tickets/{ticket}", params={"after": after})
        return TicketState.model_validate(response)
