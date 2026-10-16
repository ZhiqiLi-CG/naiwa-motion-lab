#!/usr/bin/env python3
"""Make honest, reproducible review sheets from the references and Blender renders.

Run with the system Python (Pillow is the only dependency):
    python3 assets-src/naiwa/make_comparisons.py

The inputs are never changed. Every original image and every render remains fully
visible. Images are uniformly resized; no silhouette is stretched or retouched.
For the first two pairs, the yellow/olive silhouette estimates only placement and
scale, aligning the visible figure heights. Reference 3 is already cropped across
the belly, so that pair instead fits both complete images into equal panels and
retains the framing and margins of each input. This avoids presenting a cropped
upper body as if its height were the height of the complete character.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
BACKGROUND = (244, 245, 242)
INK = (30, 39, 34)
MUTED = (88, 99, 91)
BORDER = (213, 219, 211)
ACCENT = (129, 151, 84)
RESAMPLE = Image.Resampling.LANCZOS
PAIR_WIDTH, PAIR_HEIGHT = 1280, 990

PAIRS = (
    ("01", "Holding the belly / standing side view", "user_ref_1.jpg", "01_holding_side.png"),
    ("02", "Belly laugh / forward bend", "user_ref_2.jpg", "02_belly_laugh.png"),
    ("03", "Peace signs / tongue out", "user_ref_3.jpg", "03_peace_tongue.png"),
)
STRESS_POSES = (
    ("Deep forward bend", "stress_deep_bend.png"),
    ("Arms overhead", "stress_arms_up.png"),
    ("Hands across the belly", "stress_belly_cross.png"),
    ("Squat", "stress_squat.png"),
    ("Leg lift", "stress_leg_lift.png"),
    ("Hop", "stress_hop.png"),
    ("Torso twist", "stress_twist.png"),
)


def font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for path in (Path("/usr/share/fonts/truetype/dejavu") / name, Path(name)):
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            pass
    return ImageFont.load_default()


def load_image(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
    white = Image.new("RGBA", image.size, "white")
    white.alpha_composite(image)
    return white.convert("RGB")


def silhouette_box(image: Image.Image) -> tuple[int, int, int, int]:
    """Estimate the coloured subject without using the neutral studio floor.

    This mask is used only to position complete images. It is never displayed,
    composited into, or applied to either source image.
    """
    _, saturation, value = image.convert("HSV").split()
    colour = saturation.point(lambda s: 255 if s >= 44 else 0)
    visible = value.point(lambda v: 255 if 28 <= v <= 252 else 0)
    bounds = ImageChops.multiply(colour, visible).getbbox()
    return bounds or (0, 0, image.width, image.height)


def centered_text(draw: ImageDraw.ImageDraw, x: int, y: int, text: str,
                  text_font: ImageFont.ImageFont, fill=INK) -> None:
    box = draw.textbbox((0, 0), text, font=text_font)
    draw.text((x - (box[2] - box[0]) / 2, y), text, font=text_font, fill=fill)


def fit_full(canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / image.width, (y1 - y0) / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), RESAMPLE)
    canvas.paste(resized, (x0 + (x1 - x0 - resized.width) // 2,
                           y0 + (y1 - y0 - resized.height) // 2))


def aligned_figures(canvas: Image.Image, images: list[Image.Image],
                    boxes: list[tuple[int, int, int, int]]) -> None:
    """Use one visible-figure height while preserving each complete input."""
    subjects = [silhouette_box(image) for image in images]
    heights = [max(1, b[3] - b[1]) for b in subjects]
    # Express full-image extents in units of visible figure height. The shared
    # above/below allowances retain all source margins while lining up crowns.
    above = max(b[1] / h for b, h in zip(subjects, heights))
    below = max((im.height - b[3]) / h for im, b, h in zip(images, subjects, heights))
    figure_height = min(
        min(box[3] - box[1] for box in boxes) / (1 + above + below),
        *( (box[2] - box[0]) * h / image.width
           for image, box, h in zip(images, boxes, heights) ),
    )
    used_height = figure_height * (1 + above + below)
    for image, subject, height, box in zip(images, subjects, heights, boxes):
        scale = figure_height / height
        resized = image.resize((max(1, round(image.width * scale)),
                                max(1, round(image.height * scale))), RESAMPLE)
        crown_y = box[1] + (box[3] - box[1] - used_height) / 2 + above * figure_height
        x = box[0] + (box[2] - box[0] - resized.width) // 2
        y = round(crown_y - subject[1] * scale)
        canvas.paste(resized, (x, y))


def save_png(image: Image.Image, path: Path) -> None:
    # Atomic replacement keeps a previous review sheet usable during rebuilds.
    temporary = path.with_name(path.stem + ".tmp.png")
    image.save(temporary, optimize=True)
    temporary.replace(path)
    print(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path)


def make_pair(number: str, title: str, reference_name: str, render_name: str,
              renders: Path) -> Image.Image:
    reference = load_image(ROOT / "references" / reference_name)
    render = load_image(renders / render_name)
    canvas = Image.new("RGB", (PAIR_WIDTH, PAIR_HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    draw.text((34, 22), f"{number}  {title}", fill=INK, font=font(29, True))
    draw.text((34, 64), "Reference fidelity and posed rig review", fill=MUTED, font=font(17))
    boxes = [(30, 143, 625, 911), (655, 143, 1250, 911)]
    for box, label in zip(boxes, ("Reference", "Rig render")):
        draw.rounded_rectangle((box[0] - 1, 101, box[2] + 1, 917), radius=8,
                               fill="white", outline=BORDER, width=1)
        centered_text(draw, (box[0] + box[2]) // 2, 109, label, font(23, True))
    if number == "03":
        for image, box in zip((reference, render), boxes):
            fit_full(canvas, image, box)
        caption = "Complete images. Both views are framed through the upper body and belly."
    else:
        aligned_figures(canvas, [reference, render], boxes)
        caption = "Complete images, uniform resizing; visible figure heights aligned. No retouching."
    draw = ImageDraw.Draw(canvas)
    centered_text(draw, 327, 926, f"{reference_name}  ({reference.width} x {reference.height})", font(15), MUTED)
    centered_text(draw, 953, 926, f"{render_name}  ({render.width} x {render.height})", font(15), MUTED)
    centered_text(draw, PAIR_WIDTH // 2, 958, caption, font(16), MUTED)
    save_png(canvas, renders / f"comparison_{number}.png")
    return canvas


def make_references(renders: Path) -> None:
    pairs = [make_pair(*pair, renders) for pair in PAIRS]
    combined = Image.new("RGB", (PAIR_WIDTH, PAIR_HEIGHT * len(pairs)), BACKGROUND)
    for index, pair in enumerate(pairs):
        combined.paste(pair, (0, index * PAIR_HEIGHT))
    save_png(combined, renders / "reference_comparisons.png")


def make_stress(renders: Path) -> None:
    card_width, card_height, gutter = 390, 510, 18
    width = 4 * card_width + 5 * gutter
    height = 2 * card_height + 3 * gutter + 116
    canvas = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    draw.text((24, 18), "Naiwa / deformation stress poses", fill=INK, font=font(29, True))
    draw.text((24, 61), "Seven poses of the same skinned rig. Complete render frames, uniformly resized.",
              fill=MUTED, font=font(17))
    for index, (title, filename) in enumerate(STRESS_POSES):
        row, column = divmod(index, 4)
        # Center the lower row of three poses beneath the first row of four.
        row_offset = 0 if row == 0 else (card_width + gutter) // 2
        x = gutter + column * (card_width + gutter) + row_offset
        y = 100 + gutter + row * (card_height + gutter)
        draw.rounded_rectangle((x, y, x + card_width, y + card_height), radius=8,
                               fill="white", outline=BORDER, width=1)
        centered_text(draw, x + card_width // 2, y + 11,
                      f"{index + 1:02d}  {title}", font(20, True))
        fit_full(canvas, load_image(renders / filename), (x + 10, y + 48, x + card_width - 10, y + 476))
        draw = ImageDraw.Draw(canvas)
        centered_text(draw, x + card_width // 2, y + 485, filename, font(12), MUTED)
    save_png(canvas, renders / "stress_poses.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", choices=("references", "stress", "all"), default="all")
    parser.add_argument("--renders-dir", type=Path, default=ROOT / "renders")
    args = parser.parse_args()
    renders = args.renders_dir.resolve()
    renders.mkdir(parents=True, exist_ok=True)
    if args.only in ("references", "all"):
        make_references(renders)
    if args.only in ("stress", "all"):
        make_stress(renders)


if __name__ == "__main__":
    main()
