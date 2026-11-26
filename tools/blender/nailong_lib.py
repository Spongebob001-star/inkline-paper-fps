"""Shared Blender helpers for the Nailong candidate pipeline.

Game space: x right, y up, z forward. Blender space: (x, -z, y).
"""
import json
import math
import os

import bpy
import bmesh
from mathutils import Vector

BODY = "F8CB4A"
BELLY = "F4E9D2"
LIMB = "7A6A55"
EYE = "3E9B4F"
PUPIL = "20242A"
MOUTH = "4A4438"
WHITE = "FFFFFF"


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c):
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def hex_to_linear(h):
    return tuple(srgb_to_linear(int(h[i:i + 2], 16)) for i in (0, 2, 4)) + (1.0,)


def linear_to_hex(rgb):
    return "".join(f"{round(max(0.0, min(1.0, linear_to_srgb(c))) * 255):02X}" for c in rgb[:3])


def mix_hex(a, b, t):
    t = max(0.0, min(1.0, t))
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(ca, cb))


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def clear_scene():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def set_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def new_object(name, verts, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def recalc_normals(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def shade_smooth(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True


def bl_point(p):
    return (p[0], -p[2], p[1])


def loft(name, sections, segments=32):
    """sections: (y, half_x, half_depth, z_center), bottom to top."""
    verts = []
    rings = []
    for y, hx, hz, zc in sections:
        if hx < 1e-7 or hz < 1e-7:
            rings.append([len(verts)])
            verts.append((0.0, -zc, y))
            continue
        ring = []
        for j in range(segments):
            a = 2 * math.pi * j / segments
            x = hx * math.cos(a)
            z = zc + hz * math.sin(a)
            ring.append(len(verts))
            verts.append((x, -z, y))
        rings.append(ring)
    faces = []
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        if len(r0) == 1 and len(r1) == 1:
            continue
        if len(r0) == 1:
            for j in range(segments):
                faces.append((r0[0], r1[(j + 1) % segments], r1[j]))
        elif len(r1) == 1:
            for j in range(segments):
                faces.append((r0[j], r0[(j + 1) % segments], r1[0]))
        else:
            for j in range(segments):
                faces.append((r0[j], r0[(j + 1) % segments], r1[(j + 1) % segments], r1[j]))
    if len(rings[0]) > 1:
        c = len(verts)
        verts.append((0.0, 0.0, sections[0][0]))
        for j in range(segments):
            faces.append((rings[0][(j + 1) % segments], rings[0][j], c))
    if len(rings[-1]) > 1:
        c = len(verts)
        verts.append((0.0, 0.0, sections[-1][0]))
        for j in range(segments):
            faces.append((rings[-1][j], rings[-1][(j + 1) % segments], c))
    obj = new_object(name, verts, faces)
    recalc_normals(obj)
    shade_smooth(obj)
    return obj


def limb_loft(name, sections, segments=20):
    """sections: (y, x_center, half_x, half_depth, z_center), bottom to top."""
    verts = []
    rings = []
    for y, xc, hx, hz, zc in sections:
        ring = []
        for j in range(segments):
            a = 2 * math.pi * j / segments
            x = xc + hx * math.cos(a)
            z = zc + hz * math.sin(a)
            ring.append(len(verts))
            verts.append((x, -z, y))
        rings.append(ring)
    faces = []
    for i in range(len(rings) - 1):
        for j in range(segments):
            faces.append((rings[i][j], rings[i][(j + 1) % segments],
                          rings[i + 1][(j + 1) % segments], rings[i + 1][j]))
    for idx, sections_idx in ((0, 0), (-1, -1)):
        c = len(verts)
        y, xc, _, _, zc = sections[sections_idx]
        verts.append((xc, -zc, y))
        for j in range(segments):
            if idx == 0:
                faces.append((rings[idx][(j + 1) % segments], rings[idx][j], c))
            else:
                faces.append((rings[idx][j], rings[idx][(j + 1) % segments], c))
    obj = new_object(name, verts, faces)
    recalc_normals(obj)
    shade_smooth(obj)
    return obj


def tube(name, points, radii, sides=14):
    """points/radii in game space; circular cross-section."""
    pts = [Vector(bl_point(p)) for p in points]
    n = len(pts)
    tangents = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        tangents.append((b - a).normalized())
    verts = []
    rings = []
    for i, p in enumerate(pts):
        t = tangents[i]
        ref = Vector((0, 0, 1)) if abs(t.dot(Vector((0, 0, 1)))) < 0.9 else Vector((0, 1, 0))
        n1 = t.cross(ref).normalized()
        n2 = t.cross(n1).normalized()
        row = []
        for j in range(sides):
            a = 2 * math.pi * j / sides
            q = p + n1 * (math.cos(a) * radii[i]) + n2 * (math.sin(a) * radii[i])
            row.append(len(verts))
            verts.append(tuple(q))
        rings.append(row)
    faces = []
    for i in range(n - 1):
        for j in range(sides):
            faces.append((rings[i][j], rings[i][(j + 1) % sides], rings[i + 1][(j + 1) % sides], rings[i + 1][j]))
    for idx, sign in ((0, -1), (n - 1, 1)):
        c = len(verts)
        verts.append(tuple(pts[idx] + tangents[idx] * (sign * radii[idx] * 0.8)))
        for j in range(sides):
            if sign > 0:
                faces.append((rings[idx][j], rings[idx][(j + 1) % sides], c))
            else:
                faces.append((rings[idx][(j + 1) % sides], rings[idx][j], c))
    obj = new_object(name, verts, faces)
    recalc_normals(obj)
    shade_smooth(obj)
    return obj


def ellipsoid(name, center, radii, segments=20, rings=12, yaw=0.0):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1.0)
    obj = bpy.context.object
    obj.name = name
    obj.location = bl_point(center)
    obj.scale = (radii[0], radii[2], radii[1])
    obj.rotation_euler[2] = yaw
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    shade_smooth(obj)
    return obj


def foot(name, center, width=0.30, length=0.36, height=0.15, yaw=0.0):
    outline = [
        (-0.09, -0.06), (-0.13, 0.00), (-0.15, 0.10), (-0.145, 0.18),
        (-0.12, 0.245), (-0.055, 0.245), (-0.025, 0.205),
        (0.00, 0.285), (0.025, 0.205), (0.055, 0.245), (0.12, 0.245),
        (0.145, 0.18), (0.15, 0.10), (0.13, 0.00), (0.09, -0.06),
    ]
    sx = width / 0.30
    sz = length / 0.36
    cy, sy = math.cos(yaw), math.sin(yaw)
    cx, cz = center[0], center[2]
    base_y = center[1] - height / 2
    top_y = center[1] + height / 2
    verts = []
    bottom, top = [], []
    for u, v in outline:
        u *= sx
        v *= sz
        x = cx + u * cy + v * sy
        z = cz - u * sy + v * cy
        bottom.append(len(verts))
        verts.append((x, -z, base_y))
        top.append(len(verts))
        verts.append((x, -z, top_y))
    faces = []
    n = len(outline)
    for j in range(n):
        k = (j + 1) % n
        faces.append((bottom[j], bottom[k], top[k], top[j]))
    cb = len(verts)
    x, z = cx, cz
    verts.append((x, -z, base_y - 0.004))
    ct = len(verts)
    verts.append((x, -z, top_y + 0.01))
    for j in range(n):
        k = (j + 1) % n
        faces.append((ct, top[j], top[k]))
        faces.append((cb, bottom[k], bottom[j]))
    obj = new_object(name, verts, faces)
    recalc_normals(obj)
    shade_smooth(obj)
    return obj


def webbed_foot(name, side, center, yaw=0.0, width=0.30, length=0.36, height=0.15):
    """Rounded sole plus three overlapping toe lobes; remeshed into one foot."""
    objs = []
    objs.append(ellipsoid(name + "-sole", center, (width * 0.50, height * 0.50, length * 0.42),
                          segments=20, rings=12, yaw=yaw))
    cx, cz = center[0], center[2]
    c, s = math.cos(yaw), math.sin(yaw)
    for i, (dx, dz, rx, rz) in enumerate((
        (-0.082, 0.150, 0.050, 0.090),
        (0.000, 0.175, 0.054, 0.100),
        (0.082, 0.150, 0.050, 0.090),
    )):
        lx, lz = dx * (width / 0.30), dz * (length / 0.36)
        tx = cx + lx * c + lz * s
        tz = cz - lx * s + lz * c
        objs.append(ellipsoid(f"{name}-toe{i}", (tx, center[1] - height * 0.15, tz),
                              (rx, height * 0.34, rz), segments=14, rings=8, yaw=yaw))
    return objs


def join(objs, name):
    set_active(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    return obj


def apply_remesh(obj, voxel=0.014, smooth_iter=3, target_tris=3600):
    set_active(obj)
    mod = obj.modifiers.new("voxel", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = voxel
    mod.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=mod.name)

    mod = obj.modifiers.new("relax", "SMOOTH")
    mod.factor = 0.35
    mod.iterations = smooth_iter
    bpy.ops.object.modifier_apply(modifier=mod.name)

    mod = obj.modifiers.new("tris", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=mod.name)

    n = len(obj.data.polygons)
    if n > target_tris:
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = target_tris / n
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if len(obj.data.polygons) > 4000:
        mod = obj.modifiers.new("decimate2", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = 3950 / len(obj.data.polygons)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    shade_smooth(obj)
    return obj


def assign_colors(obj, color_fn):
    mesh = obj.data
    attr = mesh.color_attributes.get("Col")
    if attr is None:
        attr = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    for i, v in enumerate(mesh.vertices):
        gx, gy, gz = v.co.x, v.co.z, -v.co.y
        attr.data[i].color = hex_to_linear(color_fn((gx, gy, gz)))
    mesh.color_attributes.active_color = attr
    mesh.color_attributes.render_color_index = mesh.color_attributes.find("Col")


def make_material(obj):
    mat = bpy.data.materials.new("nailong-clay")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.62
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.25
    vcol = nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = "Col"
    links.new(vcol.outputs["Color"], bsdf.inputs["Base Color"])
    obj.data.materials.append(mat)


def setup_render(out_dir):
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 48
    scene.render.resolution_x = 720
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = -0.65

    world = bpy.data.worlds.new("nailong-world")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.93, 0.92, 0.90, 1.0)
    bg.inputs[1].default_value = 0.58
    scene.world = world

    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, -0.004))
    floor = bpy.context.object
    floor.name = "floor"
    mat = bpy.data.materials.new("floor")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.88, 0.87, 0.85, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.95
    floor.data.materials.append(mat)

    lights = [
        ((-3.2, -4.0, 4.8), 360, 5.0),
        ((3.8, -2.4, 3.4), 210, 5.0),
        ((0.0, 4.2, 4.2), 300, 5.0),
        ((0.0, -1.0, 6.2), 140, 4.0),
    ]
    for i, (pos, energy, size) in enumerate(lights):
        data = bpy.data.lights.new(f"area{i}", "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        obj = bpy.data.objects.new(f"area{i}", data)
        bpy.context.collection.objects.link(obj)
        obj.location = pos
        obj.rotation_euler = (Vector((0, 0, 1.2)) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.95
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    os.makedirs(out_dir, exist_ok=True)
    return scene, cam


def render_views(scene, cam, out_dir, prefix):
    target = Vector((0, 0, 1.21))
    views = [
        ("front", (0.0, -6.0, 1.21), 2.95, target),
        ("side", (6.0, 0.0, 1.21), 2.95, target),
        ("back", (0.0, 6.0, 1.21), 2.95, target),
        ("three_quarter", (4.6, -4.6, 2.35), 3.05, Vector((0, 0, 1.12))),
    ]
    for name, pos, scale, look in views:
        cam.location = Vector(pos)
        cam.data.ortho_scale = scale
        cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(out_dir, f"{prefix}-{name}.png")
        bpy.ops.render.render(write_still=True)
        print("VIEW_OK", name, scene.render.filepath)


def export_bs(obj, out_file):
    set_active(obj)
    mesh = obj.data
    attr = mesh.color_attributes.get("Col")
    pos = []
    for v in mesh.vertices:
        gx, gy, gz = v.co.x, v.co.z, -v.co.y
        pos.extend((round(gx * 1000), round(gy * 1000), round(gz * 1000)))
    mesh.calc_loop_triangles()
    idx = []
    for tri in mesh.loop_triangles:
        idx.extend(tri.vertices)
    cols = [linear_to_hex(attr.data[i].color) for i in range(len(mesh.vertices))]
    data = {"name": "bs", "sm": 1, "pos": pos, "col": cols, "idx": idx}
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    size = os.path.getsize(out_file)
    print("EXPORT", out_file, "verts", len(cols), "tris", len(idx) // 3, "bytes", size)
    return data, size


def cross_section(obj, y):
    mesh = obj.data
    xs, zs = [], []
    co = [v.co for v in mesh.vertices]
    for e in mesh.edges:
        a, b = co[e.vertices[0]], co[e.vertices[1]]
        if a.z == b.z:
            continue
        if (a.z - y) * (b.z - y) > 0:
            continue
        t = (y - a.z) / (b.z - a.z)
        x = a.x + (b.x - a.x) * t
        z = (-a.y) + ((-b.y) - (-a.y)) * t
        xs.append(x)
        zs.append(z)
    if not xs:
        return None
    return max(xs) - min(xs), max(zs) - min(zs)


def stats(obj, label="N1"):
    mesh = obj.data
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.z for v in mesh.vertices]
    zs = [-v.co.y for v in mesh.vertices]
    lo = (min(xs), min(ys), min(zs))
    hi = (max(xs), max(ys), max(zs))
    h = hi[1] - lo[1]
    print("STATS", label, "verts", len(mesh.vertices), "tris", len(mesh.polygons),
          "bbox_m", [round(a, 3) for a in (*lo, *hi)], "height", round(h, 3))
    fractions = [0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.55, 0.60, 0.70, 0.75, 0.80, 0.90, 0.95, 0.98]
    for f in fractions:
        y = lo[1] + f * h
        sec = cross_section(obj, y)
        if sec is None:
            print("PROFILE", f, None)
            continue
        w, d = sec
        print("PROFILE", f, "w", round(w / h, 3), "d", round(d / h, 3), "w_m", round(w, 3), "d_m", round(d, 3))
    return {"verts": len(mesh.vertices), "tris": len(mesh.polygons), "bbox": (*lo, *hi), "height": h}