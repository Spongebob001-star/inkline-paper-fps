"""Build reference-centric N5 comparison sheets and silhouette metrics."""
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots", "nailong")
N5 = os.path.join(SHOTS, "n5")
REF = os.path.join(ROOT, "reference", "reference", "naiwa-three-view.jpg")
OUT_SHEET = os.path.join(N5, "n5-reference-vs-candidates.png")
OUT_FACE = os.path.join(N5, "n5-face-comparison.png")
FONT = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"

REF_BOXES = {
    "front": (42, 149, 456, 836),
    "side": (480, 148, 749, 838),
    "back": (768, 148, 1176, 835),
}

CANDIDATES = [
    ("REFERENCE", {
        "front": (REF, REF_BOXES["front"]),
        "side": (REF, REF_BOXES["side"]),
        "back": (REF, REF_BOXES["back"]),
    }),
    ("N3", {
        "front": (os.path.join(SHOTS, "n3-front.png"), None),
        "side": (os.path.join(SHOTS, "n3-side.png"), None),
        "back": (os.path.join(SHOTS, "n3-back.png"), None),
    }),
    ("N4", {
        "front": (os.path.join(SHOTS, "n4-front.png"), None),
        "side": (os.path.join(SHOTS, "n4-side.png"), None),
        "back": (os.path.join(SHOTS, "n4-back.png"), None),
    }),
    ("BIGDIU", {
        "front": (os.path.join(N5, "third-front.png"), None),
        "side": (os.path.join(N5, "third-side.png"), None),
        "back": (os.path.join(N5, "third-back.png"), None),
    }),
    ("REFINED", {
        "front": (os.path.join(N5, "fix-refined-front.png"), None),
        "side": (os.path.join(N5, "fix-refined-side.png"), None),
        "back": (os.path.join(N5, "fix-refined-back.png"), None),
    }),
    ("NAIFROG", {
        "front": (os.path.join(N5, "naifrog-front.png"), None),
        "side": (os.path.join(N5, "naifrog-side.png"), None),
        "back": (os.path.join(N5, "naifrog-back.png"), None),
    }),
]


def load_view(path, box):
    im = Image.open(path).convert("RGB")
    if box:
        im = im.crop(box)
    return im


def runs(mask_row, min_len=8):
    out = []
    start = None
    for i, v in enumerate(mask_row):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i - 1))
            start = None
    if start is not None and len(mask_row) - start >= min_len:
        out.append((start, len(mask_row) - 1))
    return out


def candidate_mask(im):
    arr = np.asarray(im).astype(np.int16)
    bg = np.median(np.concatenate([arr[:, :15], arr[:, -15:]], axis=1), axis=1).astype(np.int16)
    dist = np.sqrt(((arr - bg[:, None, :]) ** 2).sum(axis=2))
    return dist > 24


def reference_mask(im):
    return np.asarray(im).min(axis=2) < 235


def tight_bbox(im, is_reference):
    mask = reference_mask(im) if is_reference else candidate_mask(im)
    # Ignore the studio floor/shadow; the model's feet end near row 745 of 900.
    if not is_reference:
        mask[825:, :] = False
    h, w = mask.shape
    x0, x1, y0, y1 = w, -1, h, -1
    for y in range(h):
        rr = runs(mask[y], min_len=6)
        if not rr:
            continue
        x0 = min(x0, min(a for a, _ in rr))
        x1 = max(x1, max(b for _, b in rr))
        y0 = min(y0, y)
        y1 = max(y1, y)
    if x1 < x0:
        return (0, 0, w - 1, h - 1), mask
    return (x0, y0, x1, y1), mask


def fit(im, w, h, upscale=False):
    im = im.copy()
    if upscale and im.width < w and im.height < h:
        s = min(w / im.width, h / im.height)
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    else:
        im.thumbnail((w, h), Image.LANCZOS)
    return im


def profile(im, is_reference, label):
    box, mask = tight_bbox(im, is_reference)
    x0, y0, x1, y1 = box
    h = y1 - y0 + 1
    w = x1 - x0 + 1
    widths = {}
    for frac in (0.1, 0.3, 0.5, 0.7, 0.9):
        y = int(round(y1 - frac * (h - 1)))
        rr = runs(mask[y], min_len=6)
        if rr:
            a = min(a for a, _ in rr)
            b = max(b for _, b in rr)
            widths[frac] = (b - a + 1) / h
        else:
            widths[frac] = 0.0
    print(
        f"{label:15s} bbox={w}x{h} w/h={w/h:.3f} "
        + " ".join(f"w@{int(f*100)}={widths[f]:.3f}" for f in widths)
    )
    return {"w": w, "h": h, "aspect": w / h, "widths": widths}


def draw_sheet():
    metrics = {}
    cell_w, cell_h = 300, 400
    label_w, header_h, footer_h = 92, 78, 34
    cols, rows = len(CANDIDATES), 3
    sheet = Image.new("RGB", (label_w + cols * cell_w, header_h + rows * cell_h + footer_h), "#F2F2F2")
    d = ImageDraw.Draw(sheet)
    f_title = ImageFont.truetype(BOLD, 22)
    f_head = ImageFont.truetype(BOLD, 19)
    f_row = ImageFont.truetype(BOLD, 16)
    f_note = ImageFont.truetype(FONT, 13)
    d.text((14, 10), "N5：参考三视图 vs 候选模型", font=f_title, fill="#222")
    d.text((14, 40), "统一高度 2.42255 m，按模型包围盒裁切", font=f_note, fill="#555")
    for c, (name, views) in enumerate(CANDIDATES):
        cx = label_w + c * cell_w
        d.text((cx + 12, 48), name, font=f_head, fill="#222")
    for r, view in enumerate(("front", "side", "back")):
        cy = header_h + r * cell_h
        d.text((12, cy + cell_h // 2 - 10), view.upper(), font=f_row, fill="#333")
        for c, (name, views) in enumerate(CANDIDATES):
            path, box = views[view]
            raw = load_view(path, box)
            is_ref = name == "REFERENCE"
            tight, _ = tight_bbox(raw, is_ref)
            metrics[f"{name}-{view}"] = profile(raw, is_ref, f"{name}-{view}")
            im = raw.crop(tight)
            if view == "side" and name in {"REFERENCE", "NAIFROG"}:
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
            im = fit(im, cell_w - 18, cell_h - 18)
            cx = label_w + c * cell_w + (cell_w - im.width) // 2
            cyy = cy + (cell_h - im.height) // 2
            sheet.paste(im, (cx, cyy))
            d.rectangle((cx, cyy, cx + im.width - 1, cyy + im.height - 1), outline="#C8C8C8")
    note = "REFINED 已绕 Z 轴校正文件内 -50.4° 的旋向；NAIFROG 使用修正标签后的旧渲染；侧视为统一阅读方向，参考/naifrog 做了水平镜像；全部仅作对比，不接入游戏。"
    d.text((14, header_h + rows * cell_h + 8), note, font=f_note, fill="#555")
    sheet.save(OUT_SHEET)
    out_json = os.path.join(ROOT, "docs", "reports", "n5-silhouette-metrics.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=2)
    print("WROTE", OUT_SHEET, sheet.size)
    print("WROTE", out_json)


def draw_faces():
    panels = [
        ("REFERENCE", load_view(REF, (150, 135, 355, 340))),
        ("N3", Image.open(os.path.join(SHOTS, "n3-face.png")).convert("RGB")),
        ("N4", Image.open(os.path.join(SHOTS, "n4-face.png")).convert("RGB")),
        ("BIGDIU", Image.open(os.path.join(N5, "third-face.png")).convert("RGB")),
        ("REFINED", load_view(os.path.join(N5, "fix-refined-front.png"), (225, 45, 505, 245))),
        ("NAIFROG", load_view(os.path.join(N5, "naifrog-front.png"), (165, 85, 555, 390))),
    ]
    cw, ch = 360, 420
    sheet = Image.new("RGB", (cw * 3, ch * 2 + 48), "#F2F2F2")
    d = ImageDraw.Draw(sheet)
    f_title = ImageFont.truetype(BOLD, 22)
    f_head = ImageFont.truetype(BOLD, 17)
    d.text((14, 12), "面部与腹部对比（参考 vs 候选）", font=f_title, fill="#222")
    for i, (name, im) in enumerate(panels):
        col, row = i % 3, i // 3
        x, y = col * cw, 48 + row * ch
        im = fit(im, cw - 20, ch - 44, upscale=True)
        sheet.paste(im, (x + (cw - im.width) // 2, y + 30 + (ch - 44 - im.height) // 2))
        d.rectangle((x + 6, y + 6, x + cw - 7, y + ch - 7), outline="#D0D0D0")
        d.text((x + 12, y + 8), name, font=f_head, fill="#222")
    sheet.save(OUT_FACE)
    print("WROTE", OUT_FACE, sheet.size)


if __name__ == "__main__":
    draw_sheet()
    print("---")
    draw_faces()
