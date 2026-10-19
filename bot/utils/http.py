import re, logging
from urllib.parse import urlencode, urlparse
from aiohttp import ClientSession, ClientTimeout
from utils.models import ChzzkToken, ChzzkUser, SteamPlayer, RconStatus


logger = logging.getLogger(__name__)


class OAuthError(Exception):
    """Linking failed. The message is shown to the user; {provider} is filled in by the caller."""


PROVIDER_ERROR = "{provider} 계정을 확인하지 못했습니다. 다시 시도해주세요."


class BaseClient(ClientSession):
    def __init__(self, base_url: str, headers: dict | None, *args, **kwargs):
        super().__init__(headers=headers, timeout=ClientTimeout(total=10), *args, **kwargs)
        self.base_url = base_url

    async def get_json(self, url: str, **kwargs) -> dict:
        async with super().get(f"{self.base_url}{url}", **kwargs) as response:
            return await response.json(content_type=None)

    async def post_json(self, url: str, **kwargs) -> dict:
        async with super().post(f"{self.base_url}{url}", **kwargs) as response:
            return await response.json(content_type=None)


class ChzzkClient(BaseClient):
    AUTHORIZE_URL = "https://chzzk.naver.com/account-interlock"

    def __init__(self, client_id: str, client_secret: str, redirect_url: str, *args, **kwargs):
        super().__init__(base_url="https://openapi.chzzk.naver.com", headers=None, *args, **kwargs)
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_url = redirect_url

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret and self.redirect_url)

    def authorize_url(self, state: str) -> str:
        query = urlencode({"clientId": self.client_id, "redirectUri": self.redirect_url, "state": state})
        return f"{self.AUTHORIZE_URL}?{query}"

    async def exchange(self, code: str, state: str) -> ChzzkToken:
        response = await self.post_json("/auth/v1/token", json={
            "grantType": "authorization_code",
            "clientId": self.client_id,
            "clientSecret": self.client_secret,
            "code": code,
            "state": state,
        })
        if response.get("code") != 200 or not response.get("content"):
            logger.warning("Chzzk token exchange failed: %s", response)
            raise OAuthError(PROVIDER_ERROR)
        return ChzzkToken.model_validate(response["content"])

    async def me(self, token: ChzzkToken) -> ChzzkUser:
        response = await self.get_json("/open/v1/users/me", headers={"Authorization": f"Bearer {token.accessToken}"})
        if response.get("code") != 200 or not response.get("content"):
            logger.warning("Chzzk users/me failed: %s", response)
            raise OAuthError(PROVIDER_ERROR)
        return ChzzkUser.model_validate(response["content"])

    async def revoke(self, token: ChzzkToken) -> None:
        # Only the identity is needed, so the token is thrown away right after use.
        try:
            await self.post_json("/auth/v1/token/revoke", json={
                "clientId": self.client_id,
                "clientSecret": self.client_secret,
                "token": token.accessToken,
                "tokenTypeHint": "access_token",
            })
        except Exception:
            logger.warning("Chzzk token revoke failed", exc_info=True)


class SteamClient(BaseClient):
    # Steam has no OAuth; OpenID 2.0 is the only way to prove someone owns a SteamID.
    OPENID_URL = "https://steamcommunity.com/openid/login"
    OPENID_NS = "http://specs.openid.net/auth/2.0"
    IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select"
    CLAIMED_ID = re.compile(r"^https://steamcommunity\.com/openid/id/(\d{17})$")

    def __init__(self, api_key: str, return_url: str, *args, **kwargs):
        super().__init__(base_url="https://api.steampowered.com", headers=None, *args, **kwargs)
        self.api_key = api_key
        self.return_url = return_url

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.return_url)

    @property
    def realm(self) -> str:
        url = urlparse(self.return_url)
        return f"{url.scheme}://{url.netloc}"

    def authorize_url(self, state: str) -> str:
        query = urlencode({
            "openid.ns": self.OPENID_NS,
            "openid.mode": "checkid_setup",
            "openid.return_to": f"{self.return_url}?{urlencode({'state': state})}",
            "openid.realm": self.realm,
            "openid.identity": self.IDENTIFIER_SELECT,
            "openid.claimed_id": self.IDENTIFIER_SELECT,
        })
        return f"{self.OPENID_URL}?{query}"

    async def verify(self, params: dict[str, str]) -> str:
        """Asks Steam whether the callback it signed is genuine and returns the SteamID64."""
        if params.get("openid.mode") != "id_res" or params.get("openid.op_endpoint") != self.OPENID_URL:
            raise OAuthError(PROVIDER_ERROR)
        # A response minted for another site must not be replayed here.
        if params.get("openid.return_to", "").split("?")[0] != self.return_url:
            raise OAuthError(PROVIDER_ERROR)
        match = self.CLAIMED_ID.match(params.get("openid.claimed_id", ""))
        if not match:
            raise OAuthError(PROVIDER_ERROR)

        data = {k: v for k, v in params.items() if k.startswith("openid.")}
        data["openid.mode"] = "check_authentication"
        async with super().post(self.OPENID_URL, data=data) as response:
            body = await response.text()
        if "is_valid:true" not in body.split("\n"):
            logger.warning("Steam OpenID check_authentication rejected: %s", body)
            raise OAuthError(PROVIDER_ERROR)
        return match.group(1)

    async def player(self, steam_id: str) -> SteamPlayer | None:
        response = await self.get_json(
            "/ISteamUser/GetPlayerSummaries/v2/",
            params={"key": self.api_key, "steamids": steam_id},
        )
        players = response.get("response", {}).get("players", [])
        return SteamPlayer.model_validate(players[0]) if players else None


class RconClient(BaseClient):
    def __init__(self, base_url: str, password: str, *args, **kwargs):
        super().__init__(base_url=base_url, headers={"Authorization": f"Bearer {password}"}, *args, **kwargs)

    async def status(self) -> RconStatus:
        async with super().get(f"{self.base_url}/v1/status") as response:
            response.raise_for_status()
            return RconStatus.model_validate(await response.json(content_type=None))
