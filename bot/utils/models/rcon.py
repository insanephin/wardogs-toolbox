from pydantic import BaseModel


class Status(BaseModel):
    serverName: str | None = None
