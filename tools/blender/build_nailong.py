"""N1 silhouette blockout for Nailong.

Run:
  blender -b --factory-startup --python tools/blender/build_nailong.py
Writes tools/blender/out/bs-candidate-n1.json and docs/screenshots/nailong/n1-*.png.
The runnable src/models/bs.json is intentionally not touched.
"""
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import nailong_lib as nl

OUT_JSON = os.path.join(HERE, "out", "bs-candidate-n1.json")
SHOTS = os.path.join(ROOT, "docs", "screenshots", "nailong")
PREFIX = "n1"


def build_body():
    sections = [
        (0.72, 0.360, 0.160, 0.000),
        (0.80, 0.415, 0.215, 0.010),
        (0.92, 0.475, 0.290, 0.020),
        (1.05, 0.520, 0.350, 0.032),
        (1.18, 0.548, 0.405, 0.040),
        (1.30, 0.558, 0.435, 0.045),
        (1.42, 0.557, 0.435, 0.045),
        (1.52, 0.548, 0.420, 0.040),
        (1.62, 0.550, 0.395, 0.030),
        (1.72, 0.515, 0.360, 0.020),
        (1.82, 0.455, 0.320, 0.008),
        (1.94, 0.355, 0.285, 0.000),
        (2.06, 0.295, 0.270, 0.000),
        (2.18, 0.245, 0.255, 0.000),
        (2.30, 0.200, 0.220, 0.000),
        (2.35, 0.185, 0.200, 0.000),
        (2.385, 0.165, 0.175, 0.000),
        (2.405, 0.135, 0.145, 0.000),
        (2.418, 0.085, 0.095, 0.000),
        (2.422, 0.000, 0.000, 0.000),
    ]
    return nl.loft("body", sections, segments=40)


def build_limbs():
    parts = [build_body()]
    for s in (-1, 1):
        arm_sections = [
            (1.82, 0.18 * s, 0.120, 0.120, 0.000),
            (1.74, 0.32 * s, 0.160, 0.145, 0.010),
            (1.61, 0.45 * s, 0.170, 0.155, 0.030),
            (1.46, 0.50 * s, 0.155, 0.150, 0.060),
            (1.30, 0.52 * s, 0.150, 0.145, 0.100),
            (1.12, 0.52 * s, 0.135, 0.130, 0.150),
            (0.96, 0.51 * s, 0.115, 0.120, 0.210),
            (0.84, 0.50 * s, 0.095, 0.100, 0.230),
        ]
        parts.append(nl.limb_loft(f"arm{s}", arm_sections, segments=20))
        parts.append(nl.ellipsoid(f"shoulder{s}", (0.42 * s, 1.64, 0.025), (0.170, 0.170, 0.150)))
        parts.append(nl.ellipsoid(f"shoulder-blend{s}", (0.45 * s, 1.59, 0.025), (0.155, 0.180, 0.140)))
        parts.append(nl.ellipsoid(f"hand{s}", (0.500 * s, 0.815, 0.248), (0.100, 0.125, 0.080)))
        parts.append(nl.ellipsoid(f"thumb{s}", (0.438 * s, 0.825, 0.300), (0.040, 0.070, 0.038)))

        leg_sections = [
            (0.135, 0.315 * s, 0.080, 0.070, 0.020),
            (0.230, 0.280 * s, 0.095, 0.080, 0.015),
            (0.360, 0.250 * s, 0.120, 0.095, 0.010),
            (0.510, 0.230 * s, 0.145, 0.115, 0.005),
            (0.660, 0.210 * s, 0.170, 0.135, 0.000),
            (0.790, 0.190 * s, 0.180, 0.140, 0.000),
        ]
        parts.append(nl.limb_loft(f"leg{s}", leg_sections, segments=20))
        parts.extend(nl.webbed_foot(f"foot{s}", s, (0.370 * s, 0.095, 0.105),
                                    yaw=0.15 * s, width=0.36, length=0.38, height=0.19))
    return parts


def color_at(p):
    x, y, z = p
    t = 0.0
    if y < 0.34:
        for s in (-1, 1):
            dx = (x - 0.37 * s) / 0.22
            dy = (y - 0.095) / 0.165
            dz = (z - 0.105) / 0.275
            d = math.sqrt(dx * dx + dy * dy + dz * dz)
            t = max(t, 1.0 - nl.smoothstep(0.92, 1.34, d))
    for s in (-1, 1):
        dx = (x - 0.500 * s) / 0.145
        dy = (y - 0.830) / 0.155
        dz = (z - 0.248) / 0.145
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        t = max(t, 1.0 - nl.smoothstep(0.84, 1.16, d))
    return nl.mix_hex(nl.BODY, nl.LIMB, t)


def main():
    nl.clear_scene()
    parts = build_limbs()
    obj = nl.join(parts, "nailong-n1")
    nl.recalc_normals(obj)
    nl.apply_remesh(obj, voxel=0.014, smooth_iter=4, target_tris=3600)
    nl.assign_colors(obj, color_at)
    nl.make_material(obj)
    info = nl.stats(obj, "N1")
    data, size = nl.export_bs(obj, OUT_JSON)
    if size > 100 * 1024 or len(data["idx"]) // 3 > 4000:
        raise RuntimeError(f"候选超限: {len(data['idx']) // 3} tris / {size} bytes")
    scene, cam = nl.setup_render(SHOTS)
    nl.render_views(scene, cam, SHOTS, PREFIX)
    print("N1_DONE", info)


if __name__ == "__main__":
    main()