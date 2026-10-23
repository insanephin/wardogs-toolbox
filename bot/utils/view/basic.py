from discord.ui import LayoutView, Container, TextDisplay
from discord import Colour


class ErrorView(LayoutView):
    def __init__(self, message: str):
        super().__init__()
        self.add_item(Container(TextDisplay(f"❌ {message}"), accent_colour=Colour.red()))


class SuccessView(LayoutView):
    def __init__(self, message: str):
        super().__init__()
        self.add_item(Container(TextDisplay(f"✅ {message}"), accent_colour=Colour.green()))
