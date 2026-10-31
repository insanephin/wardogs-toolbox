from discord import ButtonStyle, Colour, Interaction
from discord.ui import LayoutView, Container, Section, Button, TextDisplay, Separator, DynamicItem
from utils.view.report import REPORT_GUIDE


class StreamerButton(DynamicItem[Button], template=r"wardogs:panel:streamer(?::(?P<server>\d+))?"):
    def __init__(self, server_id: int | None):
        self.server_id = server_id
        custom_id = "wardogs:panel:streamer" if server_id is None else f"wardogs:panel:streamer:{server_id}"
        super().__init__(Button(label="인증하기", style=ButtonStyle.primary, custom_id=custom_id))

    @classmethod
    async def from_custom_id(cls, interaction: Interaction, _item: Button, match):
        server = match["server"]
        return cls(int(server) if server else None)

    async def callback(self, interaction: Interaction):
        await interaction.client.get_cog("Verify").start_streamer(interaction, self.server_id)


class ReportButton(DynamicItem[Button], template=r"wardogs:panel:report:(?P<server>\d+)"):
    def __init__(self, server_id: int):
        self.server_id = server_id
        super().__init__(Button(label="신고하기", style=ButtonStyle.danger, custom_id=f"wardogs:panel:report:{server_id}"))

    @classmethod
    async def from_custom_id(cls, interaction: Interaction, _item: Button, match):
        return cls(int(match["server"]))

    async def callback(self, interaction: Interaction):
        await interaction.client.get_cog("Report").start_report(interaction, self.server_id)


class WhitelistPanelView(LayoutView):
    def __init__(self, server_id: int, server_name: str):
        super().__init__(timeout=None)

        container = Container(accent_colour=Colour.blurple())
        container.add_item(TextDisplay(f"## {server_name} 화이트리스트 인증"))
        container.add_item(Separator())
        container.add_item(Section(
            TextDisplay("### 우측 버튼을 누르면 연동 안내가 나옵니다."),
            accessory=StreamerButton(server_id),
        ))
        self.add_item(container)


class PublicPanelView(LayoutView):
    def __init__(self, server_id: int, server_name: str, join_url: str | None):
        super().__init__(timeout=None)

        container = Container(accent_colour=Colour.blurple())
        container.add_item(TextDisplay(f"## {server_name}"))
        container.add_item(Separator())
        if join_url:
            container.add_item(Section(
                TextDisplay("### 서버 접속\n버튼을 누르면 게임 서버 접속 페이지가 열립니다."),
                accessory=Button(label="접속하기", style=ButtonStyle.link, url=join_url),
            ))
        container.add_item(Section(
            TextDisplay(f"### 신고\n{REPORT_GUIDE}"),
            accessory=ReportButton(server_id),
        ))
        self.add_item(container)
