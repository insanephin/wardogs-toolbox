from discord import Colour, Interaction
from discord.ui import LayoutView, Container, TextDisplay


UNREACHABLE = "지금은 대시보드에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
SERVER_DELETED = "이 패널의 서버가 삭제되었습니다. 관리자에게 문의해주세요."


class ErrorView(LayoutView):
    def __init__(self, message: str):
        super().__init__()
        self.add_item(Container(TextDisplay(f"❌ {message}"), accent_colour=Colour.red()))


class SuccessView(LayoutView):
    def __init__(self, message: str):
        super().__init__()
        self.add_item(Container(TextDisplay(f"✅ {message}"), accent_colour=Colour.green()))


async def send_error(interaction: Interaction, message: str):
    view = ErrorView(message)
    if interaction.response.is_done():
        await interaction.edit_original_response(view=view)
    else:
        await interaction.response.send_message(view=view, ephemeral=True)
