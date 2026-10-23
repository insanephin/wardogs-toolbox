from aiohttp import ClientSession, ClientTimeout
from utils.models import Ticket, TicketState


class BaseClient(ClientSession):
    def __init__(self, base_url: str, headers: dict, *args, **kwargs):
        super().__init__(headers=headers, *args, **kwargs)
        self.base_url = base_url.rstrip("/")

    async def get(self, url: str, **kwargs):
        async with super().get(f"{self.base_url}{url}", **kwargs) as response:
            response.raise_for_status()
            return await response.json()

    async def post(self, url: str, **kwargs):
        async with super().post(f"{self.base_url}{url}", **kwargs) as response:
            response.raise_for_status()
            return await response.json()


class DashboardClient(BaseClient):
    def __init__(self, base_url: str, secret: str, *args, **kwargs):
        super().__init__(
            base_url=base_url,
            headers={"Authorization": f"Bearer {secret}"},
            timeout=ClientTimeout(total=40),
            *args, **kwargs
        )

    async def create_ticket(self, discord_id: int, discord_name: str) -> Ticket:
        response = await self.post("/api/discord/tickets", json={"discordId": str(discord_id), "discordName": discord_name})
        return Ticket.model_validate(response)

    async def wait_ticket(self, ticket: str, after: int) -> TicketState:
        response = await self.get(f"/api/discord/tickets/{ticket}", params={"after": after})
        return TicketState.model_validate(response)
