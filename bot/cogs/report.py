import logging
from discord import Interaction
from discord.ext import commands
from utils.http import DashboardError
from utils.image import ImageError, prepare_image
from utils.view import ErrorView, ReportModal, ReportDoneView, UNREACHABLE, SERVER_DELETED


logger = logging.getLogger(__name__)


class Report(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @property
    def verify(self):
        return self.bot.get_cog("Verify")

    async def start_report(self, interaction: Interaction, server_id: int):
        if not await self.verify.guard(interaction):
            return
        try:
            info = await self.verify.client.report_info(server_id, interaction.user.id)
        except DashboardError as e:
            message = SERVER_DELETED if e.status == 404 else e.message
            return await interaction.response.send_message(view=ErrorView(message), ephemeral=True)
        except Exception:
            logger.error("Failed to load report info", exc_info=True)
            return await interaction.response.send_message(view=ErrorView(UNREACHABLE), ephemeral=True)

        if info.remaining <= 0:
            return await interaction.response.send_message(view=ErrorView(f"신고는 1시간에 {info.limits.per_hour}건까지 할 수 있습니다"), ephemeral=True)
        await interaction.response.send_modal(ReportModal(info, self.submit))

    async def submit(self, interaction: Interaction, modal: ReportModal):
        await interaction.response.defer(ephemeral=True, thinking=True)
        info, user, client = modal.info, interaction.user, self.verify.client
        try:
            result = await client.create_report(info.server.id, user.id, user.display_name, {
                "targetName": modal.target.value,
                "description": modal.description.value,
            })
        except DashboardError as e:
            return await interaction.edit_original_response(view=ErrorView(e.message or "신고를 접수하지 못했습니다."))
        except Exception:
            logger.error("Failed to create report", exc_info=True)
            return await interaction.edit_original_response(view=ErrorView(UNREACHABLE))

        attached, failures = 0, []
        for attachment in modal.images.values:
            try:
                data, content_type = await prepare_image(attachment, info.limits.image_bytes)
                await client.upload_report_image(result.id, user.id, data, content_type)
                attached += 1
            except (DashboardError, ImageError) as e:
                failures.append(str(e))
            except Exception:
                logger.warning("Failed to upload report image", exc_info=True)
                failures.append(f"{attachment.filename}: 업로드에 실패했습니다")

        await interaction.edit_original_response(view=ReportDoneView(info.server.name, modal.target.value.strip(), attached, failures))


async def setup(bot):
    await bot.add_cog(Report(bot))
