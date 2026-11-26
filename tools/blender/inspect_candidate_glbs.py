"""Read-only inspection + orientation-corrected four-view renders for N5 candidates."""
import bpy
import math
import os
import sys
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "docs", "screenshots", "nailong", "n5")
TARGET_H = 2.42255

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nailong_lib import setup_render, render_views  # noqa: E402


def clean():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def world_bbox(meshes):
    pts = []
    for ob in meshes:
        for c in ob.bound_box:
            pts.append(ob.matrix_world @ Vector(c))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def world_center(ob):
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return sum(pts, Vector()) / 8.0


def load(path):
    clean()
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    return meshes


def describe(label, path):
    meshes = load(path)
    print(f"\n===== {label} =====")
    print("file:", path)
    print("objects:")
    for ob in bpy.context.scene.objects:
        parent = ob.parent.name if ob.parent else None
        line = f"  {ob.name!r} type={ob.type} parent={parent!r}"
        if ob.type == "MESH":
            line += f" verts={len(ob.data.vertices)} polys={len(ob.data.polygons)} mats={[m.name if m else None for m in ob.data.materials]}"
        print(line)
    print("transforms:")
    for ob in bpy.context.scene.objects:
        loc, rot, scl = ob.matrix_world.decompose()
        print(f"  {ob.name!r} loc=({loc.x:.4f},{loc.y:.4f},{loc.z:.4f}) rot_euler=({math.degrees(rot.to_euler().x):.1f},{math.degrees(rot.to_euler().y):.1f},{math.degrees(rot.to_euler().z):.1f}) scale=({scl.x:.4f},{scl.y:.4f},{scl.z:.4f})")
    if not meshes:
        print("NO MESHES")
        return None
    lo, hi = world_bbox(meshes)
    print(f"bbox min=({lo.x:.4f},{lo.y:.4f},{lo.z:.4f}) max=({hi.x:.4f},{hi.y:.4f},{hi.z:.4f}) size=({hi.x-lo.x:.4f},{hi.y-lo.y:.4f},{hi.z-lo.z:.4f})")
    print("materials:")
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            print(f"  {mat.name!r} (no nodes)")
            continue
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        col = tuple(round(v, 3) for v in bsdf.inputs["Base Color"].default_value) if bsdf else None
        print(f"  {mat.name!r} base={col}")
    # eye candidates
    for ob in meshes:
        names = (ob.name + " " + " ".join(m.name for m in ob.data.materials if m)).lower()
        if any(k in names for k in ("eye", "iris", "pupil", "眼", "sclera")):
            c = world_center(ob)
            print(f"  EYE? {ob.name!r} center=({c.x:.4f},{c.y:.4f},{c.z:.4f}) size_z={ob.dimensions.z:.4f}")
    return meshes


def yaw_from_face(meshes):
    """Estimate facing in XY from eye-mesh centers relative to the body center."""
    eyes = []
    for ob in meshes:
        names = (ob.name + " " + " ".join(m.name for m in ob.data.materials if m)).lower()
        if any(k in names for k in ("eye", "iris", "pupil", "sclera")):
            eyes.append(world_center(ob))
    lo, hi = world_bbox(meshes)
    center = (lo + hi) / 2.0
    if not eyes:
        return None, center, None
    eye = sum(eyes, Vector()) / len(eyes)
    vec = eye - center
    yaw = math.atan2(vec.y, vec.x)
    print(f"eye_count={len(eyes)} eye_mid=({eye.x:.4f},{eye.y:.4f},{eye.z:.4f}) center=({center.x:.4f},{center.y:.4f},{center.z:.4f}) yaw_deg={math.degrees(yaw):.1f}")
    return yaw, center, eye


def normalize_and_render(label, meshes, yaw, prefix):
    """Center on XY, feet at z=0, scale to TARGET_H, rotate facing to -Y."""
    # Parent every top-level imported object (root empty or meshes) to a pivot empty.
    pivot = bpy.data.objects.new("PIVOT", None)
    bpy.context.scene.collection.objects.link(pivot)
    tops = [o for o in bpy.context.scene.objects if o.parent is None and o.type in {"MESH", "EMPTY"} and o is not pivot]
    for ob in tops:
        ob.parent = pivot
        ob.matrix_parent_inverse = pivot.matrix_world.inverted()
    lo, hi = world_bbox(meshes)
    center = (lo + hi) / 2.0
    # Move pivot so bbox XY center is at origin, feet at z=0.
    pivot.location = (-center.x, -center.y, -lo.z)
    bpy.context.view_layer.update()
    lo, hi = world_bbox(meshes)
    size = hi.z - lo.z
    s = TARGET_H / size
    pivot.scale = (s, s, s)
    # Rotate about Z so face points to -Y (front camera). yaw is direction from center to eyes.
    # Desired direction is -Y => angle -90 deg in XY. Rotate by delta.
    if yaw is not None:
        delta = math.radians(-90.0) - yaw
        pivot.rotation_euler = (0, 0, delta)
    bpy.context.view_layer.update()
    lo, hi = world_bbox(meshes)
    # Re-center after rotation.
    center = (lo + hi) / 2.0
    pivot.location.x -= center.x
    pivot.location.y -= center.y
    pivot.location.z -= lo.z
    bpy.context.view_layer.update()
    lo, hi = world_bbox(meshes)
    print(f"normalized bbox size=({hi.x-lo.x:.4f},{hi.y-lo.y:.4f},{hi.z-lo.z:.4f}) min_z={lo.z:.4f}")
    # Render
    scene, cam = setup_render(OUT)
    render_views(scene, cam, OUT, prefix)
    return lo, hi


def main():
    refined = os.path.join(ROOT, "reference", "third_party", "naiwa-static-model", "naiwa-refined.glb")
    naifrog = os.path.join(ROOT, "reference", "third_party", "naiwa-survival", "naifrog.glb")
    for label, path, prefix in (
        ("refined", refined, "fix-refined"),
        ("naifrog", naifrog, None),
    ):
        meshes = describe(label, path)
        if not meshes:
            continue
        if prefix is None:
            print("render skipped: naifrog uses the already-normalized naifrog-front/side/back renders")
            continue
        yaw, center, eye = yaw_from_face(meshes)
        normalize_and_render(label, meshes, yaw, prefix)


main()
