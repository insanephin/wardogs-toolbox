from discord import ButtonStyle, Colour
from discord.ui import LayoutView, Container, Section, Button, TextDisplay, Separator, ActionRow
from utils.models import Ticket, TicketState


def join_button(ticket: Ticket) -> ActionRow:
    return ActionRow(Button(label=f"{ticket.server.name} 접속", style=ButtonStyle.link, url=ticket.server.join_url))


class DoneView(LayoutView):
    def __init__(self, ticket: Ticket, message: str):
        super().__init__()

        container = Container(TextDisplay(f"✅ {message}"), accent_colour=Colour.green())
        if ticket.server and ticket.server.join_url:
            container.add_item(join_button(ticket))
        self.add_item(container)


class VerifyView(LayoutView):
    def __init__(self, ticket: Ticket, state: TicketState | None = None, error: str | None = None):
        super().__init__()

        container = Container(accent_colour=Colour.red() if error else Colour.blurple())
        container.add_item(TextDisplay("## 화이트리스트 연동"))

        if ticket.server:
            container.add_item(TextDisplay(f"-# 적용 서버: **{ticket.server.name}**"))

        link = ticket.link
        if link:
            status = "접속 우선권 적용됨" if link.reserved else "접속 우선권 적용 대기 중"
            body = f"- 치지직: **{link.chzzk_name or '-'}**\n- 스팀: **{link.steam_name or link.steam_id}**\n- 연결 상태: {status}\n-# 다른 계정으로 바꾸려면 버튼을 통해 다시 로그인하세요."
        else:
            body = "스팀에 로그인하면 화이트리스트에 등록되고 서버 접속 우선권(예약 슬롯)이 자동으로 적용됩니다.\n치지직 연동은 선택이며, 함께 연동하려면 스팀보다 **먼저** 로그인하세요."
        container.add_item(TextDisplay(body))
        container.add_item(Separator())

        steps = [
            ("치지직 (선택)", state.chzzk_name if state else None, ticket.urls.chzzk, "선택 사항"),
            ("스팀", state.steam_name if state else None, ticket.urls.steam, "로그인 필요"),
        ]
        for i, (provider, name, url, pending) in enumerate(steps, start=1):
            container.add_item(Section(
                TextDisplay(f"**{i}. {provider}**"),
                TextDisplay(f"✅ {name}" if name else pending),
                accessory=Button(label="다시 로그인" if name else "로그인", style=ButtonStyle.link, url=url),
            ))

        if link and link.reserved and ticket.server and ticket.server.join_url:
            container.add_item(join_button(ticket))
        if error:
            container.add_item(TextDisplay(f"❌ {error}"))
        container.add_item(TextDisplay("-# 로그인은 브라우저에서 열리고, 진행 상황은 이 메시지에 바로 반영됩니다. 링크는 10분 동안 유효하며 본인만 볼 수 있습니다."))
        self.add_item(container)
