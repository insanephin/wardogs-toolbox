from discord import ButtonStyle, Colour, Interaction
from discord.ui import LayoutView, Container, Section, Button, TextDisplay, Separator


class StreamerButton(Button):
    def __init__(self):
        super().__init__(label="인증하기", style=ButtonStyle.primary, custom_id="wardogs:panel:streamer")

    async def callback(self, interaction: Interaction):
        await interaction.client.get_cog("Verify").start_streamer(interaction)


class PanelView(LayoutView):
    def __init__(self):
        super().__init__(timeout=None)

        container = Container(accent_colour=Colour.blurple())
        container.add_item(TextDisplay("## WARDOGS 인증"))
        container.add_item(TextDisplay("웹사이트로 연동하셨을 경우에도 스트리머 인증을 위해 해당 패널에서 한번 더 부탁드립니다."))
        container.add_item(Separator())
        container.add_item(Section(
            TextDisplay("### 우측 버튼을 누르면 본인에게만 보이는 연동 안내가 나옵니다."),
            accessory=StreamerButton(),
        ))
        self.add_item(container)
