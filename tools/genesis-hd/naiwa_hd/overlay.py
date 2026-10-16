"""The product mark in a corner of the frames: plain and small, the frog is the subject."""

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
MARK = "Naiwa Motion Lab"


class Watermark:
    def __init__(self, width: int, height: int):
        px = max(12, int(height * 0.02))
        font = ImageFont.truetype(FONT, px)
        box = font.getbbox(MARK)
        w, h = box[2] - box[0] + px, box[3] - box[1] + px
        org = (px // 2 - box[0], px // 2 - box[1])
        shadow = Image.new("L", (w, h), 0)
        ImageDraw.Draw(shadow).text((org[0], org[1] + 1), MARK, font=font, fill=90)
        self.mark = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        self.mark.paste((20, 30, 40, 255), (0, 0), shadow.filter(ImageFilter.GaussianBlur(px * 0.1)))
        ImageDraw.Draw(self.mark).text(org, MARK, font=font, fill=(255, 255, 255, 200))
        margin = int(height * 0.022)
        self.at = (width - w - margin, height - h - margin)

    def draw(self, rgb: np.ndarray) -> np.ndarray:
        frame = Image.fromarray(rgb).convert("RGBA")
        frame.alpha_composite(self.mark, self.at)
        return np.asarray(frame.convert("RGB"))
