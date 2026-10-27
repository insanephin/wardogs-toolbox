from typing import Optional
from pydantic import BaseModel, ConfigDict, Field


class StreamerLink(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    steam_id: str = Field(alias="steamId")
    steam_name: Optional[str] = Field(default=None, alias="steamName")
    chzzk_name: Optional[str] = Field(default=None, alias="chzzkName")
    reserved: bool


class VerifyUrls(BaseModel):
    chzzk: str
    steam: str


class TicketServer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    join_url: Optional[str] = Field(default=None, alias="joinUrl")


class PanelServer(BaseModel):
    id: int
    name: str


class AdminServers(BaseModel):
    linked: bool
    servers: list[PanelServer]


class Ticket(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ticket: str
    urls: VerifyUrls
    expires_at: int = Field(alias="expiresAt")
    link: Optional[StreamerLink] = None
    server: Optional[TicketServer] = None


class TicketState(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    version: int
    result: Optional[str] = None
    chzzk_name: Optional[str] = Field(default=None, alias="chzzkName")
    steam_name: Optional[str] = Field(default=None, alias="steamName")
    done: bool
