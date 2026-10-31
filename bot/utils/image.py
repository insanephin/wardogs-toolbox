import asyncio
from io import BytesIO
from discord import Attachment
from PIL import Image, ImageOps, UnidentifiedImageError


MAX_SIDE = 1920
MAX_SOURCE_BYTES = 25 * 1024 * 1024
QUALITIES = (85, 70, 50)


class ImageError(Exception):
    pass


def _shrink(name: str, data: bytes, max_bytes: int) -> bytes:
    try:
        with Image.open(BytesIO(data)) as source:
            img = ImageOps.exif_transpose(source)
            img.thumbnail((MAX_SIDE, MAX_SIDE))
            img = img.convert("RGBA" if img.has_transparency_data else "RGB")
            for quality in QUALITIES:
                out = BytesIO()
                img.save(out, "WEBP", quality=quality)
                if out.tell() <= max_bytes:
                    return out.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ImageError(f"{name}: 이미지를 읽지 못했습니다")
    raise ImageError(f"{name}: {max_bytes // (1024 * 1024)}MB 이하로 줄이지 못했습니다")


async def prepare_image(attachment: Attachment, max_bytes: int) -> tuple[bytes, str]:
    if attachment.size > MAX_SOURCE_BYTES:
        raise ImageError(f"{attachment.filename}: 파일이 너무 큽니다 ({MAX_SOURCE_BYTES // (1024 * 1024)}MB까지)")
    data = await attachment.read()
    return await asyncio.to_thread(_shrink, attachment.filename, data, max_bytes), "image/webp"
