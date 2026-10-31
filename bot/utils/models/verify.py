from pydantic import BaseModel, Field


class StreamerLink(BaseModel):
    steam_id: str = Field(alias="steamId")
    steam_name: str | None = Field(default=None, alias="steamName")
    chzzk_name: str | None = Field(default=None, alias="chzzkName")
    reserved: bool


class VerifyUrls(BaseModel):
    chzzk: str
    steam: str


class TicketServer(BaseModel):
    name: str
    join_url: str | None = Field(default=None, alias="joinUrl")


class PanelServer(BaseModel):
    id: int
    name: str
    join_url: str | None = Field(default=None, alias="joinUrl")


class GuildServer(BaseModel):
    id: int
    name: str


class Ticket(BaseModel):
    ticket: str
    urls: VerifyUrls
    expires_at: int = Field(alias="expiresAt")
    link: StreamerLink | None = None
    server: TicketServer | None = None


class TicketState(BaseModel):
    version: int
    result: str | None = None
    chzzk_name: str | None = Field(default=None, alias="chzzkName")
    steam_name: str | None = Field(default=None, alias="steamName")
    done: bool
