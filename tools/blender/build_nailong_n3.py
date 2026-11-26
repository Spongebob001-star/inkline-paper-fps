"""N3 belly color block and body gradient for Nailong.

Run:
  blender -b --factory-startup --python tools/blender/build_nailong_n3.py
Writes tools/blender/out/bs-candidate-n3.json and docs/screenshots/nailong/n3-*.png.
The N1/N2 scripts and outputs and the runnable src/models/bs.json are not touched.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import nailong_lib as nl

OUT_JSON = os.path.join(HERE, "out", "bs-candidate-n3.json")
SHOTS = os.path.join(ROOT, "docs", "screenshots", "nailong")
PREFIX = "n3"

BODY_TOP = "F8CE52"
BODY_MID = "F2C247"
BODY_LOW = "D99C2A"
BELLY = "F4E9D2"
BELLY_EDGE = "E6D1B3"

BELLY_CY = 1.36
BELLY_RX = 0.535
BELLY_RY = 0.360
BELLY_SEGS = 36
BELLY_TARGET_TRIS = 2890

IRIS_IN = "5C9350"
IRIS_MID = "6CA75B"
IRIS_OUT = "7DB569"
PUPIL = "0A0D09"
RIM = "3A452C"
MOUTH = "5A3A12"

BODY_SECTIONS = [
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
    (1.92, 0.360, 0.302, 0.002),
    (2.00, 0.312, 0.298, 0.000),
    (2.07, 0.280, 0.297, 0.000),
    (2.14, 0.266, 0.294, 0.006),
    (2.21, 0.254, 0.282, 0.000),
    (2.28, 0.241, 0.256, 0.000),
    (2.34, 0.212, 0.208, 0.000),
    (2.38, 0.180, 0.178, 0.000),
    (2.40, 0.152, 0.152, 0.000),
    (2.412, 0.115, 0.118, 0.000),
    (2.420, 0.070, 0.076, 0.000),
    (2.423, 0.000, 0.000, 0.000),
]

EYE_X = 0.152
EYE_Y = 2.265
EYE_RIM_R = 0.061


def build_body():
    return nl.loft("body", BODY_SECTIONS, segments=40)


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


def body_yellow(y):
    if y >= 1.5:
        return nl.mix_hex(BODY_MID, BODY_TOP, nl.smoothstep(1.5, 2.3, y))
    return nl.mix_hex(BODY_LOW, BODY_MID, nl.smoothstep(0.72, 1.5, y))


def belly_point(x, y, lift):
    z = head_surface(x, y)[0]
    e = 0.004
    zx = (head_surface(x + e, y)[0] - head_surface(x - e, y)[0]) / (2 * e)
    zy = (head_surface(x, y + e)[0] - head_surface(x, y - e)[0]) / (2 * e)
    n = Vector((-zx, -zy, 1.0))
    n.normalize()
    return x + n.x * lift, y + n.y * lift, z + n.z * lift


def ring_color(spec, y):
    if spec == "belly":
        return BELLY
    if spec == "body":
        return body_yellow(y)
    kind, t = spec
    if kind == "cream":
        return nl.mix_hex(BELLY, BELLY_EDGE, t)
    return nl.mix_hex(BELLY_EDGE, body_yellow(y), t)


def belly_patch(body):
    """Cream panel shrink-wrapped onto the remeshed torso, fading into the body at the rim."""
    ring_defs = [
        (0.20, 0.0070, "belly"),
        (0.40, 0.0065, "belly"),
        (0.58, 0.0060, ("cream", 0.18)),
        (0.74, 0.0055, ("cream", 0.55)),
        (0.87, 0.0050, ("fade", 0.25)),
        (0.95, 0.0045, ("fade", 0.65)),
        (1.00, 0.0040, "body"),
    ]
    segs = BELLY_SEGS
    verts, colors, rings = [], [], []

    def project(x, y, lift):
        origin = Vector((x, -2.0, y))
        ok, loc, nrm, _ = body.ray_cast(origin, Vector((0.0, 1.0, 0.0)), distance=4.0)
        if not ok:
            return nl.bl_point(belly_point(x, y, lift))
        p = loc + nrm * lift
        return tuple(p)

    verts.append(project(0.0, BELLY_CY, 0.0075))
    colors.append(BELLY)
    for d, lift, spec in ring_defs:
        row = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            x = BELLY_RX * d * math.cos(a)
            y = BELLY_CY + BELLY_RY * d * math.sin(a)
            row.append(len(verts))
            verts.append(project(x, y, lift))
            colors.append(ring_color(spec, y))
        rings.append(row)

    skirt = []
    for j in range(segs):
        a = 2 * math.pi * j / segs
        x = BELLY_RX * math.cos(a)
        y = BELLY_CY + BELLY_RY * math.sin(a)
        skirt.append(len(verts))
        verts.append(project(x, y, -0.010))
        colors.append(body_yellow(y))

    faces = []
    for j in range(segs):
        faces.append((0, rings[0][j], rings[0][(j + 1) % segs]))
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for j in range(segs):
            faces.append((a[j], b[j], b[(j + 1) % segs], a[(j + 1) % segs]))
    top = rings[-1]
    for j in range(segs):
        faces.append((top[j], skirt[j], skirt[(j + 1) % segs], top[(j + 1) % segs]))

    obj = nl.new_object("belly", verts, faces)
    nl.shade_smooth(obj)
    paint(obj, colors)
    return obj


def color_at(p):
    x, y, z = p
    c = body_yellow(y)
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
    return nl.mix_hex(c, nl.LIMB, t)


def head_surface(x, y):
    for i in range(len(BODY_SECTIONS) - 1):
        y0, hx0, hz0, zc0 = BODY_SECTIONS[i]
        y1, hx1, hz1, zc1 = BODY_SECTIONS[i + 1]
        if y0 <= y <= y1:
            t = (y - y0) / (y1 - y0) if y1 > y0 else 0.0
            hx = hx0 + (hx1 - hx0) * t
            hz = hz0 + (hz1 - hz0) * t
            zc = zc0 + (zc1 - zc0) * t
            q = max(0.0, 1.0 - (x / hx) ** 2)
            return zc + hz * math.sqrt(q), hx, hz, zc
    raise ValueError(f"y={y} outside body sections")


def paint(obj, colors):
    attr = obj.data.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    for i, h in enumerate(colors):
        attr.data[i].color = nl.hex_to_linear(h)
    obj.data.color_attributes.active_color = attr
    obj.data.color_attributes.render_color_index = 0


def eye_disc(side):
    x0 = side * EYE_X
    y0 = EYE_Y
    rings = [
        (0.000, PUPIL),
        (0.034, PUPIL),
        (0.036, IRIS_IN),
        (0.0595, IRIS_OUT),
        (EYE_RIM_R, RIM),
    ]
    segs = 22
    xscale = 1.0
    center_lift = 0.008
    rim_lift = 0.0025
    verts, colors, ring_idx = [], [], []
    for r, hex_color in rings:
        pupil_dy = -0.006 if r <= 0.034 else 0.0
        if r == 0.0:
            z = head_surface(x0, y0 + pupil_dy)[0] + center_lift
            verts.append(nl.bl_point((x0, y0 + pupil_dy, z)))
            colors.append(hex_color)
            ring_idx.append([len(verts) - 1])
            continue
        row = []
        lift = rim_lift + (center_lift - rim_lift) * (1.0 - (r / EYE_RIM_R) ** 2)
        for j in range(segs):
            a = 2 * math.pi * j / segs
            x = x0 + r * math.cos(a) * xscale
            y = y0 + pupil_dy + r * math.sin(a)
            z = head_surface(x, y)[0] + lift
            row.append(len(verts))
            verts.append(nl.bl_point((x, y, z)))
            colors.append(hex_color)
        ring_idx.append(row)

    bottom = []
    for j in range(segs):
        a = 2 * math.pi * j / segs
        x = x0 + EYE_RIM_R * math.cos(a) * xscale
        y = y0 + EYE_RIM_R * math.sin(a)
        z = head_surface(x, y)[0] - 0.006
        bottom.append(len(verts))
        verts.append(nl.bl_point((x, y, z)))
        colors.append(RIM)

    faces = []
    for j in range(segs):
        faces.append((ring_idx[0][0], ring_idx[1][j], ring_idx[1][(j + 1) % segs]))
    for k in range(1, len(ring_idx) - 1):
        a, b = ring_idx[k], ring_idx[k + 1]
        for j in range(segs):
            faces.append((a[j], b[j], b[(j + 1) % segs], a[(j + 1) % segs]))
    top = ring_idx[-1]
    for j in range(segs):
        faces.append((top[j], bottom[j], bottom[(j + 1) % segs], top[(j + 1) % segs]))

    obj = nl.new_object(f"eye{side}", verts, faces)
    nl.shade_smooth(obj)
    paint(obj, colors)
    return obj


def mouth_line():
    pts = []
    for x in (-0.105, -0.078, -0.045, -0.015, 0.000, 0.015, 0.045, 0.078, 0.105):
        y = 2.128 + 0.019 * (x / 0.105) ** 2
        z = head_surface(x, y)[0] + 0.0015
        pts.append((x, y, z))
    obj = nl.tube("mouth", pts, [0.0045] * len(pts), sides=6)
    paint(obj, [MOUTH] * len(obj.data.vertices))
    return obj


def render_closeup(scene, cam, out_dir, name, target_y, ortho):
    cam.location = Vector((0.0, -6.0, target_y))
    cam.data.ortho_scale = ortho
    cam.rotation_euler = (Vector((0.0, 0.0, target_y)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.filepath = os.path.join(out_dir, f"{PREFIX}-{name}.png")
    bpy.ops.render.render(write_still=True)
    scene.render.resolution_x = 720
    scene.render.resolution_y = 900
    print("VIEW_OK", name, scene.render.filepath)


def main():
    nl.clear_scene()
    parts = build_limbs()
    obj = nl.join(parts, "nailong-n3")
    nl.recalc_normals(obj)
    nl.apply_remesh(obj, voxel=0.014, smooth_iter=4, target_tris=BELLY_TARGET_TRIS)
    nl.assign_colors(obj, color_at)

    features = [obj, belly_patch(obj), eye_disc(-1), eye_disc(1), mouth_line()]
    obj = nl.join(features, "nailong-n3")
    nl.shade_smooth(obj)
    nl.make_material(obj)

    info = nl.stats(obj, "N3")
    data, size = nl.export_bs(obj, OUT_JSON)
    if size > 100 * 1024 or len(data["idx"]) // 3 > 4000:
        raise RuntimeError(f"候选超限: {len(data['idx']) // 3} tris / {size} bytes")
    scene, cam = nl.setup_render(SHOTS)
    nl.render_views(scene, cam, SHOTS, PREFIX)
    render_closeup(scene, cam, SHOTS, "face", 2.225, 0.92)
    render_closeup(scene, cam, SHOTS, "belly", 1.36, 1.42)
    print("N3_DONE", info)


if __name__ == "__main__":
    main()