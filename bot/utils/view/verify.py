from discord import ButtonStyle, Colour
from discord.ui import LayoutView, Container, Section, Button, TextDisplay, Separator
from utils.models import Ticket, TicketState


class VerifyView(LayoutView):
    def __init__(self, ticket: Ticket, state: TicketState | None = None, error: str | None = None):
        super().__init__()

        container = Container(accent_colour=Colour.red() if error else Colour.blurple())
        container.add_item(TextDisplay("## 스트리머 인증"))

        link = ticket.link
        if link:
            status = "접속 우선권 적용됨" if link.reserved else "접속 우선권 적용 대기 중"
            body = f"- 치지직: **{link.chzzk_name or '-'}**\n- 스팀: **{link.steam_name or link.steam_id}**\n- 연결 상태: {status}\n-# 다른 계정으로 바꾸려면 버튼을 통해 다시 로그인하세요."
        else:
            body = "두 서비스에 모두 로그인하면 스트리머로 등록되고 서버 접속 우선권(예약 슬롯)이 자동으로 적용됩니다.\n이미 웹에서 연동했다면 한가지만 로그인해도 됩니다."
        container.add_item(TextDisplay(body))
        container.add_item(Separator())

        steps = [
            ("치지직", state.chzzk_name if state else None, ticket.urls.chzzk),
            ("스팀", state.steam_name if state else None, ticket.urls.steam),
        ]
        for i, (provider, name, url) in enumerate(steps, start=1):
            container.add_item(Section(
                TextDisplay(f"**{i}. {provider}**"),
                TextDisplay(f"✅ {name}" if name else "로그인 필요"),
                accessory=Button(label="다시 로그인" if name else "로그인", style=ButtonStyle.link, url=url),
            ))

        if error:
            container.add_item(TextDisplay(f"❌ {error}"))
        container.add_item(TextDisplay("-# 로그인은 브라우저에서 열리고, 진행 상황은 이 메시지에 바로 반영됩니다. 링크는 10분 동안 유효하며 본인만 볼 수 있습니다."))
        self.add_item(container)
