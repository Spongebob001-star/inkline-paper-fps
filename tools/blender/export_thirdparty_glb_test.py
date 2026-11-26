"""Export the third-party Nailoong .blend to a test GLB (read-only source).

Output goes to dev/n5/ and is a feasibility artifact, not a game asset.
Prints GLB structure so the color/material loss is measurable.
"""
import os
import struct
import sys

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "reference", "third_party", "nailong-blender-model", "nailong_colored.blend")
OUT = os.path.join(ROOT, "dev", "n5", "nailong_colored_test.glb")


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=SRC)
    for ob in bpy.data.objects:
        ob.select_set(ob.type == "MESH")
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_animations=True)
    with open(OUT, "rb") as f:
        magic, version, total = struct.unpack("<III", f.read(12))
        chunk_len, _ = struct.unpack("<II", f.read(8))
        gltf = __import__("json").loads(f.read(chunk_len).decode("utf-8"))
    print("GLB", OUT, os.path.getsize(OUT), "magic_ok", magic == 0x46546C67, "v", version)
    print("COUNT meshes", len(gltf.get("meshes", [])), "materials", len(gltf.get("materials", [])),
          "textures", len(gltf.get("textures", [])), "skins", len(gltf.get("skins", [])),
          "animations", len(gltf.get("animations", [])))
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            attrs = prim["attributes"]
            tris = gltf["accessors"][prim["indices"]]["count"] // 3
            print("PRIM material", prim.get("material"), "verts", gltf["accessors"][attrs["POSITION"]]["count"],
                  "tris", tris, "attrs", sorted(attrs))
    for i, mat in enumerate(gltf.get("materials", [])):
        pbr = mat.get("pbrMetallicRoughness", {})
        print("MAT", i, mat.get("name"), "baseColorFactor", pbr.get("baseColorFactor"),
              "baseColorTexture", "baseColorTexture" in pbr)


main()
