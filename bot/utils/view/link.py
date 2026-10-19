from discord import ButtonStyle, Colour, Interaction
from discord.ui import LayoutView, Container, Section, ActionRow, TextDisplay, Separator, Button
from utils.database import AccountLink


PROVIDERS = {"chzzk": "치지직", "steam": "스팀"}
COLOURS = {"chzzk": Colour.from_str("#00FFA3"), "steam": Colour.from_str("#1B2838")}


def _cog(interaction: Interaction):
    return interaction.client.get_cog("Link")


class LinkButton(Button):
    def __init__(self, provider: str):
        super().__init__(
            label=f"{PROVIDERS[provider]} 연동",
            style=ButtonStyle.success if provider == "chzzk" else ButtonStyle.primary,
            custom_id=f"link:{provider}",
        )
        self.provider = provider

    async def callback(self, interaction: Interaction):
        await _cog(interaction).start_link(interaction, self.provider)


class StatusButton(Button):
    def __init__(self):
        super().__init__(label="내 연동 정보", style=ButtonStyle.secondary, custom_id="link:status")

    async def callback(self, interaction: Interaction):
        await _cog(interaction).show_status(interaction)


class UnlinkButton(Button):
    def __init__(self, provider: str):
        super().__init__(label="연동 해제", style=ButtonStyle.danger)
        self.provider = provider

    async def callback(self, interaction: Interaction):
        await _cog(interaction).unlink(interaction, self.provider)


class LinkPanelView(LayoutView):
    """The public panel. Persistent: registered once in setup_hook so its buttons survive restarts."""

    def __init__(self):
        super().__init__(timeout=None)
        container = Container(accent_colour=Colour.blurple())
        container.add_item(TextDisplay("# 계정 연동"))
        container.add_item(TextDisplay(
            "치지직 채널과 스팀 계정을 디스코드 계정에 연동합니다.\n"
            "공개 프로필(채널 ID·이름, SteamID·닉네임)만 저장됩니다."
        ))
        container.add_item(Separator())
        container.add_item(ActionRow(LinkButton("chzzk"), LinkButton("steam"), StatusButton()))
        self.add_item(container)


class LinkStartView(LayoutView):
    """Ephemeral: the per-user sign-in link. Edited into the result once the callback arrives."""

    def __init__(self, provider: str, url: str, minutes: int):
        super().__init__()
        container = Container(accent_colour=COLOURS[provider])
        container.add_item(TextDisplay(f"### {PROVIDERS[provider]} 연동"))
        container.add_item(TextDisplay(
            f"버튼을 눌러 로그인해주세요. 링크는 {minutes}분 후 만료됩니다.\n완료되면 이 메시지가 바뀝니다."
        ))
        container.add_item(ActionRow(Button(label="로그인하기", style=ButtonStyle.link, url=url)))
        self.add_item(container)


class LinkStatusView(LayoutView):
    def __init__(self, row: AccountLink | None):
        super().__init__()
        container = Container(accent_colour=Colour.blurple())
        container.add_item(TextDisplay("### 내 연동 정보"))

        accounts = {
            "chzzk": (row.chzzk_name, row.chzzk_linked_at) if row and row.chzzk_channel_id else None,
            "steam": (row.steam_name, row.steam_linked_at) if row and row.steam_id else None,
        }
        for provider, label in PROVIDERS.items():
            account = accounts[provider]
            if account is None:
                container.add_item(TextDisplay(f"**{label}**\n-# 연동 안 됨"))
                continue
            name, linked_at = account
            since = f" · <t:{int(linked_at.timestamp())}:R>" if linked_at else ""
            container.add_item(Section(
                TextDisplay(f"**{label}**\n{name}{since}"),
                accessory=UnlinkButton(provider),
            ))
        self.add_item(container)
