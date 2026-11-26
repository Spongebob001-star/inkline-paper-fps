"""N4 torso, back, shoulder and foot shaping for Nailong.

Run:
  blender -b --factory-startup --python tools/blender/build_nailong_n4.py
Writes tools/blender/out/bs-candidate-n4.json and docs/screenshots/nailong/n4-*.png.
The N1/N2/N3 scripts and outputs and the runnable src/models/bs.json are not touched.
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

OUT_JSON = os.path.join(HERE, "out", "bs-candidate-n4.json")
SHOTS = os.path.join(ROOT, "docs", "screenshots", "nailong")
PREFIX = "n4"

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
    (0.72, 0.378, 0.178, 0.000),
    (0.80, 0.432, 0.238, 0.006),
    (0.92, 0.494, 0.314, 0.014),
    (1.05, 0.532, 0.374, 0.024),
    (1.18, 0.553, 0.424, 0.032),
    (1.30, 0.558, 0.454, 0.037),
    (1.42, 0.555, 0.454, 0.037),
    (1.52, 0.544, 0.440, 0.033),
    (1.62, 0.538, 0.416, 0.026),
    (1.72, 0.508, 0.382, 0.018),
    (1.80, 0.468, 0.352, 0.012),
    (1.86, 0.420, 0.330, 0.008),
    (1.92, 0.366, 0.306, 0.004),
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

BELLY_BULGE = 0.0045


def build_body():
    obj = nl.loft("body", BODY_SECTIONS, segments=40)
    for v in obj.data.vertices:
        gx, gy, gz = v.co.x, v.co.z, -v.co.y
        if gz <= 0.01:
            continue
        d = math.hypot(gx / 0.56, (gy - 1.36) / 0.40)
        if d >= 1.30:
            continue
        f = 1.0 - nl.smoothstep(0.85, 1.30, d)
        v.co.y -= BELLY_BULGE * f
    obj.data.update()
    return obj


def webbed_foot_n4(name, center, yaw=0.0, width=0.42, length=0.42, height=0.182):
    """Wide flat sole, instep filler and shallow toe ripples; remeshed into one foot."""
    objs = [nl.ellipsoid(name + "-sole", center,
                         (width * 0.54, height * 0.50, length * 0.47),
                         segments=20, rings=12, yaw=yaw)]
    objs.append(nl.ellipsoid(name + "-instep",
                             (center[0] - 0.018 * (1 if center[0] > 0 else -1),
                              center[1] + height * 0.33, center[2] - 0.025),
                             (0.115, height * 0.63, 0.150),
                             segments=16, rings=10, yaw=yaw))
    cx, cz = center[0], center[2]
    c, s = math.cos(yaw), math.sin(yaw)
    for i, (dx, dz, rx, rz) in enumerate((
        (-0.090, 0.125, 0.055, 0.070),
        (0.000, 0.150, 0.060, 0.078),
        (0.090, 0.125, 0.055, 0.070),
    )):
        lx, lz = dx * (width / 0.42), dz * (length / 0.42)
        tx = cx + lx * c + lz * s
        tz = cz - lx * s + lz * c
        objs.append(nl.ellipsoid(f"{name}-toe{i}", (tx, center[1] - height * 0.12, tz),
                                 (rx, height * 0.26, rz), segments=14, rings=8, yaw=yaw))
    return objs


def build_limbs():
    parts = [build_body()]
    for s in (-1, 1):
        arm_sections = [
            (0.82, 0.498 * s, 0.098, 0.102, 0.235),
            (0.94, 0.508 * s, 0.116, 0.120, 0.215),
            (1.08, 0.514 * s, 0.134, 0.132, 0.165),
            (1.24, 0.515 * s, 0.148, 0.146, 0.115),
            (1.40, 0.505 * s, 0.158, 0.154, 0.070),
            (1.53, 0.480 * s, 0.160, 0.154, 0.032),
            (1.64, 0.424 * s, 0.146, 0.144, 0.010),
            (1.74, 0.332 * s, 0.116, 0.122, 0.000),
        ]
        parts.append(nl.limb_loft(f"arm{s}", arm_sections, segments=20))
        parts.append(nl.ellipsoid(f"hand{s}", (0.500 * s, 0.815, 0.248), (0.104, 0.128, 0.084)))
        parts.append(nl.ellipsoid(f"thumb{s}", (0.438 * s, 0.825, 0.300), (0.042, 0.068, 0.040)))

        leg_sections = [
            (0.135, 0.315 * s, 0.080, 0.070, 0.020),
            (0.230, 0.280 * s, 0.096, 0.082, 0.015),
            (0.360, 0.252 * s, 0.122, 0.098, 0.010),
            (0.510, 0.232 * s, 0.148, 0.118, 0.005),
            (0.660, 0.212 * s, 0.174, 0.138, 0.000),
            (0.800, 0.192 * s, 0.186, 0.144, 0.000),
        ]
        parts.append(nl.limb_loft(f"leg{s}", leg_sections, segments=20))
        parts.append(nl.ellipsoid(f"hip{s}", (0.190 * s, 0.800, 0.005), (0.170, 0.150, 0.190)))
        parts.append(nl.ellipsoid(f"hip-side{s}", (0.300 * s, 0.820, 0.000), (0.130, 0.120, 0.170)))
        parts.extend(webbed_foot_n4(f"foot{s}", (0.370 * s, 0.091, 0.100),
                                    yaw=0.15 * s, width=0.42, length=0.42, height=0.182))
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
        (0.18, 0.0060, "belly", 1.0),
        (0.38, 0.0058, "belly", 1.0),
        (0.56, 0.0059, ("cream", 0.10), 1.0),
        (0.72, 0.0054, ("cream", 0.38), 0.85),
        (0.85, 0.0048, ("fade", 0.35), 0.6),
        (0.94, 0.0034, ("fade", 0.75), 0.35),
        (1.00, 0.0028, "body", 0.2),
    ]
    segs = BELLY_SEGS
    verts, colors, rings = [], [], []
    ray_dir = Vector((0.0, 1.0, 0.0))
    forward = Vector((0.0, -1.0, 0.0))
    grid = 0.01
    span = 5
    cells = {}
    for v in body.data.vertices:
        cells.setdefault((round(v.co.x / grid), round(v.co.z / grid)), []).append(v.co.copy())

    def project(x, y, lift, bump_scale=1.0):
        origin = Vector((x, -2.0, y))
        ok, loc, nrm, _ = body.ray_cast(origin, ray_dir, distance=4.0)
        if not ok:
            return nl.bl_point(belly_point(x, y, lift))
        bump = 0.0
        cx, cy = round(x / grid), round(y / grid)
        for ix in range(cx - span, cx + span + 1):
            for iy in range(cy - span, cy + span + 1):
                for co in cells.get((ix, iy), ()):
                    bump = max(bump, (co - loc).dot(nrm))
        facing = max(0.6, -nrm.y)
        p = loc + forward * ((lift + max(0.0, bump) * bump_scale) / facing)
        return tuple(p)

    verts.append(project(0.0, BELLY_CY, 0.0054))
    colors.append(BELLY)
    for d, lift, spec, bump_scale in ring_defs:
        row = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            x = BELLY_RX * d * math.cos(a)
            y = BELLY_CY + BELLY_RY * d * math.sin(a)
            row.append(len(verts))
            verts.append(project(x, y, lift, bump_scale))
            colors.append(ring_color(spec, y))
        rings.append(row)

    skirt = []
    for j in range(segs):
        a = 2 * math.pi * j / segs
        x = BELLY_RX * math.cos(a)
        y = BELLY_CY + BELLY_RY * math.sin(a)
        skirt.append(len(verts))
        verts.append(project(x, y, -0.008, 0.0))
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
            dx = (x - 0.37 * s) / 0.250
            dy = (y - 0.100) / 0.190
            dz = (z - 0.100) / 0.330
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
    obj = nl.join(parts, "nailong-n4")
    nl.recalc_normals(obj)
    nl.apply_remesh(obj, voxel=0.014, smooth_iter=4, target_tris=BELLY_TARGET_TRIS)
    nl.assign_colors(obj, color_at)

    features = [obj, belly_patch(obj), eye_disc(-1), eye_disc(1), mouth_line()]
    obj = nl.join(features, "nailong-n4")
    nl.shade_smooth(obj)
    nl.make_material(obj)

    info = nl.stats(obj, "N4")
    data, size = nl.export_bs(obj, OUT_JSON)
    if size > 100 * 1024 or len(data["idx"]) // 3 > 4000:
        raise RuntimeError(f"候选超限: {len(data['idx']) // 3} tris / {size} bytes")
    scene, cam = nl.setup_render(SHOTS)
    nl.render_views(scene, cam, SHOTS, PREFIX)
    render_closeup(scene, cam, SHOTS, "face", 2.225, 0.92)
    render_closeup(scene, cam, SHOTS, "belly", 1.36, 1.42)
    print("N4_DONE", info)


if __name__ == "__main__":
    main()