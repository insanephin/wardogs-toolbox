from pydantic import BaseModel


class Token(BaseModel):
    accessToken: str


class User(BaseModel):
    channelId: str
    channelName: str
