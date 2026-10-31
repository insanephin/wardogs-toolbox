from pydantic import BaseModel, Field


class ReportServer(BaseModel):
    id: int
    name: str


class ReportLimits(BaseModel):
    per_hour: int = Field(alias="perHour")
    target: int
    description: int
    images: int
    image_bytes: int = Field(alias="imageBytes")


class ReportInfo(BaseModel):
    server: ReportServer
    remaining: int
    limits: ReportLimits


class ReportResult(BaseModel):
    id: int
