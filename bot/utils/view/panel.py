from discord import ButtonStyle, Colour, Interaction
from discord.ui import LayoutView, Container, Section, Button, TextDisplay, Separator, DynamicItem


class StreamerButton(DynamicItem[Button], template=r"wardogs:panel:streamer(?::(?P<server>\d+))?"):
    def __init__(self, server_id: int | None):
        self.server_id = server_id
        custom_id = "wardogs:panel:streamer" if server_id is None else f"wardogs:panel:streamer:{server_id}"
        super().__init__(Button(label="인증하기", style=ButtonStyle.primary, custom_id=custom_id))

    @classmethod
    async def from_custom_id(cls, interaction: Interaction, item: Button, match):
        server = match["server"]
        return cls(int(server) if server else None)

    async def callback(self, interaction: Interaction):
        await interaction.client.get_cog("Verify").start_streamer(interaction, self.server_id)


class PanelView(LayoutView):
    def __init__(self, server_id: int, server_name: str):
        super().__init__(timeout=None)

        container = Container(accent_colour=Colour.blurple())
        container.add_item(TextDisplay(f"## WARDOGS 인증\n-# 서버: **{server_name}**"))
        container.add_item(Separator())
        container.add_item(Section(
            TextDisplay("### 우측 버튼을 누르면 본인에게만 보이는 연동 안내가 나옵니다."),
            accessory=StreamerButton(server_id),
        ))
        self.add_item(container)
