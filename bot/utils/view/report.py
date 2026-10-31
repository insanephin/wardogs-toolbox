import logging
from collections.abc import Awaitable, Callable
from discord import Colour, Interaction, TextStyle
from discord.ui import LayoutView, Container, TextDisplay, Modal, Label, TextInput, FileUpload
from utils.models import ReportInfo
from utils.view.basic import send_error


logger = logging.getLogger(__name__)
REPORT_GUIDE = "신고할 플레이어의 닉네임과 사유를 적어주세요.\n-# 허위 신고는 제재될 수 있습니다."


class ReportModal(Modal):
    def __init__(self, info: ReportInfo, submit: Callable[[Interaction, "ReportModal"], Awaitable[None]]):
        super().__init__(title=f"신고 · {info.server.name}"[:45], timeout=900)
        self.info = info
        self._submit = submit

        self.target = TextInput(max_length=info.limits.target, placeholder="신고할 플레이어의 게임 닉네임")
        self.description = TextInput(style=TextStyle.paragraph, max_length=info.limits.description, placeholder="언제, 어느 맵에서, 무슨 일이 있었는지 적어주세요")
        self.images = FileUpload(required=False, max_values=info.limits.images)

        self.add_item(TextDisplay(f"{REPORT_GUIDE}\n\n⚠️ 익명모드의 경우 닉네임 확인 불가능합니다. 확실한 처리를 위해 사건발생 시간, 플레이어 UID를 첨부해주세요."))
        self.add_item(Label(text="닉네임", component=self.target))
        self.add_item(Label(text="사유", component=self.description))
        self.add_item(Label(text="이미지 (선택)", description=f"최대 {info.limits.images}장", component=self.images))

    async def on_submit(self, interaction: Interaction):
        await self._submit(interaction, self)

    async def on_error(self, interaction: Interaction, error: Exception):
        logger.error("Report modal failed", exc_info=error)
        await send_error(interaction, "신고를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.")


class ReportDoneView(LayoutView):
    def __init__(self, server_name: str, target: str, attached: int, failures: list[str]):
        super().__init__()

        container = Container(accent_colour=Colour.orange() if failures else Colour.green())
        body = f"✅ **{server_name}** 신고가 접수되었습니다.\n- 대상: **{target}**"
        if attached:
            body += f"\n- 이미지: {attached}장"
        container.add_item(TextDisplay(body))
        if failures:
            container.add_item(TextDisplay(f"⚠️ 신고가 접수되었지만 이미지 {len(failures)}장 업로드에 실패하였습니다: {' / '.join(dict.fromkeys(failures))}"))
        self.add_item(container)
