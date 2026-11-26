"""Read-only audit + normalized renders of the third-party Nailoong .blend.

Original file is never written. Renders use the same camera/light/floor setup as
the N3/N4 passes, after a uniform normalization (height 2.42255, feet on z=0,
x/y bbox center at 0) applied only in memory.
"""
import json
import os
import sys
from collections import Counter, defaultdict

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "reference", "third_party", "nailong-blender-model", "nailong_colored.blend")
SHOTS = os.path.join(ROOT, "docs", "screenshots", "nailong", "n5")
REPORT = os.path.join(ROOT, "docs", "reports", "n5-thirdparty-audit.json")
sys.path.insert(0, os.path.join(ROOT, "tools", "blender"))
import nailong_lib as nl  # noqa: E402

N4_HEIGHT = 2.42255


def dump_material(mat):
    info = {"name": mat.name, "blend_method": mat.blend_method,
            "use_backface_culling": mat.use_backface_culling}
    if not mat.use_nodes:
        return info
    nodes = mat.node_tree.nodes
    info["node_types"] = dict(Counter(n.type for n in nodes))
    info["node_count"] = len(nodes)
    for n in nodes:
        if n.type == "BSDF_PRINCIPLED":
            def val(key):
                sock = n.inputs.get(key)
                if sock is None:
                    return None
                v = sock.default_value
                return [round(float(x), 4) for x in v] if hasattr(v, "__len__") else round(float(v), 4)
            info["principled"] = {k: val(k) for k in
                                  ("Base Color", "Metallic", "Roughness", "IOR", "Alpha",
                                   "Specular IOR Level", "Subsurface Weight")}
    return info


def tri_area(a, b, c):
    return (b - a).cross(c - a).length * 0.5


def main():
    bpy.ops.wm.open_mainfile(filepath=SRC)
    scene = bpy.context.scene
    report = {"source": SRC, "file_version": list(bpy.data.version)}

    objs = list(bpy.data.objects)
    report["objects"] = [{"name": o.name, "type": o.type,
                          "loc": [round(v, 4) for v in o.location],
                          "rot": [round(v, 4) for v in o.rotation_euler],
                          "scale": [round(v, 4) for v in o.scale]} for o in objs]

    mesh_objs = [o for o in objs if o.type == "MESH"]
    ob = mesh_objs[0]
    me = ob.data
    report["mesh_name"] = ob.name
    report["counts"] = {"verts": len(me.vertices), "edges": len(me.edges),
                        "polys": len(me.polygons), "loops": len(me.loops)}
    me.calc_loop_triangles()
    report["counts"]["tris"] = len(me.loop_triangles)

    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    dim = mx - mn
    ctr = (mn + mx) * 0.5
    report["bbox"] = {"min": [round(v, 4) for v in mn], "max": [round(v, 4) for v in mx],
                      "size": [round(v, 4) for v in dim], "center": [round(v, 4) for v in ctr],
                      "height": round(dim.z, 4)}

    report["materials"] = [dump_material(m) if m else None for m in me.materials]
    report["material_slots"] = [m.name if m else None for m in me.materials]
    report["faces_per_material"] = {str(k): v for k, v in
                                    Counter(p.material_index for p in me.polygons).items()}
    slot_centroids = {}
    for idx in range(len(me.materials)):
        acc = Vector((0, 0, 0))
        n = 0
        for p in me.polygons:
            if p.material_index == idx:
                acc += p.center
                n += 1
        if n:
            slot_centroids[str(idx)] = {"name": me.materials[idx].name if me.materials[idx] else None,
                                        "faces": n,
                                        "centroid": [round(v, 4) for v in (acc / n)]}
    report["material_centroids"] = slot_centroids

    report["uv"] = []
    for layer in me.uv_layers:
        us = [d.uv[0] for d in layer.data]
        vs = [d.uv[1] for d in layer.data]
        degenerate = 0
        out_of_range = 0
        for tri in me.loop_triangles:
            a, b, c = (Vector(layer.data[i].uv) for i in tri.loops)
            if abs((b - a).cross(c - a)) < 1e-12:
                degenerate += 1
        for u, v in zip(us, vs):
            if u < -1e-6 or u > 1 + 1e-6 or v < -1e-6 or v > 1 + 1e-6:
                out_of_range += 1
        report["uv"].append({"name": layer.name, "active": layer.active,
                             "uv_min": [round(min(us), 4), round(min(vs), 4)],
                             "uv_max": [round(max(us), 4), round(max(vs), 4)],
                             "degenerate_tris": degenerate, "out_of_range_loops": out_of_range,
                             "nonzero_uv_faces": None})

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    boundary = sum(1 for e in bm.edges if e.is_boundary)
    nonmanifold_edges = sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary)
    wire = sum(1 for e in bm.edges if len(e.link_faces) == 0)
    nonmanifold_verts = sum(1 for v in bm.verts if not v.is_manifold)
    report["topology"] = {"boundary_edges": boundary, "nonmanifold_edges": nonmanifold_edges,
                          "wire_edges": wire, "nonmanifold_verts": nonmanifold_verts}

    islands = []
    seen = set()
    vert_adj = defaultdict(list)
    for e in bm.edges:
        a, b = e.verts[0].index, e.verts[1].index
        vert_adj[a].append(b)
        vert_adj[b].append(a)
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v.index]
        seen.add(v.index)
        comp = []
        while stack:
            i = stack.pop()
            comp.append(i)
            for j in vert_adj[i]:
                if j not in seen:
                    seen.add(j)
                    stack.append(j)
        islands.append(comp)
    island_stats = []
    for comp in islands:
        cset = set(comp)
        vol = 0.0
        area = 0.0
        ntri = 0
        for f in bm.faces:
            if f.verts[0].index not in cset:
                continue
            vs = [v.co for v in f.verts]
            for k in range(1, len(vs) - 1):
                a, b, c = vs[0], vs[k], vs[k + 1]
                vol += a.dot(b.cross(c)) / 6.0
                area += tri_area(a, b, c)
                ntri += 1
        island_stats.append({"verts": len(comp), "tris": ntri,
                             "volume": round(vol, 6), "area": round(area, 6)})
    island_stats.sort(key=lambda d: -d["verts"])
    report["islands"] = {"count": len(islands), "largest": island_stats[:8]}

    zero_area = 0
    min_area = 1e9
    for tri in me.loop_triangles:
        a, b, c = (me.vertices[i].co for i in tri.vertices)
        ar = tri_area(a, b, c)
        min_area = min(min_area, ar)
        if ar < 1e-10:
            zero_area += 1
    report["degenerate"] = {"zero_area_tris": zero_area, "min_tri_area": min_area}

    bm2 = bmesh.new()
    bm2.from_mesh(me)
    before = len(bm2.verts)
    bmesh.ops.remove_doubles(bm2, verts=bm2.verts, dist=1e-5)
    report["duplicate_verts"] = {"merged_at_1e-5": before - len(bm2.verts)}
    bm2.free()

    coords = [v.co.copy() for v in me.vertices]
    polys = [tuple(t.vertices) for t in me.loop_triangles]
    bvh = BVHTree.FromPolygons(coords, polys, all_triangles=True)
    pairs = bvh.overlap(bvh)
    self_hits = 0
    sample = []
    for i, j in pairs:
        if i >= j:
            continue
        ti, tj = polys[i], polys[j]
        if set(ti) & set(tj):
            continue
        self_hits += 1
        if len(sample) < 5:
            sample.append([i, j])
    report["self_intersections"] = {"non_adjacent_pairs": self_hits, "sample": sample,
                                    "bvh_overlap_pairs": len(pairs)}

    report["normals"] = {"has_custom_normals": me.has_custom_normals,
                         "sharp_edges": sum(1 for e in me.edges if e.use_edge_sharp),
                         "smooth_faces": sum(1 for p in me.polygons if p.use_smooth),
                         "flipped_islands": [s for s in island_stats if s["volume"] < 0]}
    report["color_attributes"] = [{"name": a.name, "domain": a.domain,
                                   "data_type": a.data_type, "active": a.name == me.color_attributes.active_color.name
                                   if me.color_attributes.active_color else False}
                                  for a in me.color_attributes]

    report["rig"] = {"armatures": [a.name for a in bpy.data.armatures],
                     "armature_objects": [o.name for o in objs if o.type == "ARMATURE"],
                     "modifiers": [(m.name, m.type) for m in ob.modifiers],
                     "vertex_groups": [g.name for g in ob.vertex_groups],
                     "shape_keys": bool(me.shape_keys),
                     "actions": [a.name for a in bpy.data.actions],
                     "animation_data": bool(ob.animation_data),
                     "nla_tracks": len(ob.animation_data.nla_tracks) if ob.animation_data else 0,
                     "drivers": len(bpy.data.anim_data) if hasattr(bpy.data, "anim_data") else None}
    report["textures"] = [i.name for i in bpy.data.images if i.source != "VIEWER"]
    report["scene_units"] = {"system": scene.unit_settings.system,
                             "scale_length": scene.unit_settings.scale_length}

    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    front_y = 0.0
    mouth = slot_centroids.get("1")
    if mouth:
        front_y = mouth["centroid"][1]
    report["orientation_guess"] = "front -Y (mouth centroid y=%.3f)" % front_y

    print("AUDIT", json.dumps(report, ensure_ascii=False)[:6000])

    # ---- presentation-only normalization (copy in memory, never saved) ----
    for o in list(bpy.data.objects):
        if o is not ob:
            bpy.data.objects.remove(o, do_unlink=True)
    mw = ob.matrix_world.copy()
    ob.parent = None
    ob.matrix_world = mw
    bpy.context.view_layer.update()
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    s = N4_HEIGHT / (mx.z - mn.z)
    if front_y > 0:
        ob.rotation_euler.z += 3.14159265
    ob.scale = (s, s, s)
    bpy.context.view_layer.update()
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    ctr = (mn + mx) * 0.5
    ob.location.x -= ctr.x
    ob.location.y -= ctr.y - 0.0
    ob.location.z -= mn.z
    bpy.context.view_layer.update()
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob

    scene, cam = nl.setup_render(SHOTS)
    nl.render_views(scene, cam, SHOTS, "third")

    def closeup(name, target_y, ortho):
        cam.location = Vector((0.0, -6.0, target_y))
        cam.data.ortho_scale = ortho
        cam.rotation_euler = ((Vector((0, 0, target_y)) - cam.location)
                              .to_track_quat("-Z", "Y").to_euler())
        scene.render.resolution_x = 720
        scene.render.resolution_y = 720
        scene.render.filepath = os.path.join(SHOTS, name)
        bpy.ops.render.render(write_still=True)
        print("CLOSEUP_OK", scene.render.filepath)
        scene.render.resolution_x = 720
        scene.render.resolution_y = 900

    closeup("third-face.png", 2.12, 0.92)
    closeup("third-belly.png", 1.30, 1.42)
    print("DONE")


main()