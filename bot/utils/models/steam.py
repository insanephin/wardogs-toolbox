from pydantic import BaseModel


class Player(BaseModel):
    steamid: str
    personaname: str
