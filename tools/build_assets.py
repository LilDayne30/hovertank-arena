# Build game assets with Blender's Python module (bpy).
#   python3 -I tools/build_assets.py -- <arena.blend> <Tank3.blend> <outdir>
# Outputs:
#   arena.glb       – Low Poly Desert Arena, uniformly scaled by ARENA_SCALE, lights/camera removed
#   arena_hf.bin    – Float32 heightfield (game coords, Y up) sampled by ray casts
#   arena_hf.json   – heightfield metadata
#   tank.glb        – Quaternius tank (Tank3) as two static nodes: "Hull" and "Turret" (gun parented to turret)
import bpy, sys, json, struct, math, mathutils

args = sys.argv[sys.argv.index('--') + 1:]
ARENA, TANK, OUT = args[0], args[1], args[2]
ARENA_SCALE = 3.0      # Blender units -> metres (pit is ~24 BU wide; x3 gives a ~70 m pit)
TANK_LENGTH = 4.4      # target hull length in metres
CELL = 0.5             # heightfield resolution (m)


def clear_non_mesh():
    for o in list(bpy.data.objects):
        if o.type not in ('MESH',):
            bpy.data.objects.remove(o, do_unlink=True)


def fix_materials():
    # Old (2.7x) files: rebuild a minimal Principled node tree from the material's flat colour so
    # the glTF exporter writes baseColorFactor and metallic=0 (glTF defaults metallic to 1).
    for m in bpy.data.materials:
        col = None
        if m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    col = tuple(n.inputs['Base Color'].default_value)
        col = col or tuple(m.diffuse_color)
        m.node_tree.nodes.clear() if m.node_tree else None
        nt = m.node_tree
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        b = nt.nodes.new('ShaderNodeBsdfPrincipled')
        b.inputs['Base Color'].default_value = col
        b.inputs['Metallic'].default_value = 0.0
        b.inputs['Roughness'].default_value = 0.9
        nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
        m.use_backface_culling = True


def recalc_normals():
    import bmesh
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        bm = bmesh.new(); bm.from_mesh(o.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(o.data); bm.free()


def export_glb(path):
    fix_materials()
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=False,
        export_apply=True, export_animations=False, export_skins=False,
        export_morph=False, export_lights=False, export_cameras=False,
        export_yup=True, export_texcoords=False, export_normals=True,
        export_materials='EXPORT', export_extras=False, export_vertex_color='NONE',
    )


# ------------------------------------------------------------------ arena
bpy.ops.wm.open_mainfile(filepath=ARENA)
clear_non_mesh()
recalc_normals()
for o in bpy.data.objects:
    o.location *= ARENA_SCALE
    o.scale *= ARENA_SCALE
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()

# bounds in Blender coords
mn = mathutils.Vector((1e9, 1e9, 1e9)); mx = -mn
for o in bpy.data.objects:
    for c in o.bound_box:
        v = o.matrix_world @ mathutils.Vector(c)
        mn = mathutils.Vector(map(min, mn, v)); mx = mathutils.Vector(map(max, mx, v))

# game coords: gx = bx, gy = bz, gz = -by
# Only the walled pit (+/-30 m after scaling) is reachable, so sample a crop around it.
CROP = 34.0
minX, maxX = -CROP, CROP
minZ, maxZ = -CROP, CROP
nx = int(math.ceil((maxX - minX) / CELL)) + 1
nz = int(math.ceil((maxZ - minZ) / CELL)) + 1
floor = mn.z
heights = []
for iz in range(nz):
    gz = minZ + iz * CELL
    for ix in range(nx):
        gx = minX + ix * CELL
        hit, loc, *_ = bpy.context.scene.ray_cast(dg, mathutils.Vector((gx, -gz, mx.z + 10)), mathutils.Vector((0, 0, -1)))
        heights.append((0.0 if abs(loc.z) < 0.02 else round(loc.z, 3)) if hit else 60.0)   # no geometry = outside the arena -> treat as wall
with open(f"{OUT}/arena_hf.bin", "wb") as f:
    f.write(struct.pack(f"<{len(heights)}f", *heights))

# pit floor statistics, to pick spawns later
meta = dict(minX=minX, minZ=minZ, cell=CELL, nx=nx, nz=nz, floor=floor, outside=60.0,
            scale=ARENA_SCALE, maxY=mx.z)
with open(f"{OUT}/arena_hf.json", "w") as f:
    json.dump(meta, f, indent=1)
export_glb(f"{OUT}/arena.glb")
print("ARENA", meta)

# ------------------------------------------------------------------ tank
bpy.ops.wm.open_mainfile(filepath=TANK)
# bake armature-deformed track meshes to rest pose static meshes
for o in list(bpy.data.objects):
    if o.type == 'MESH':
        for m in list(o.modifiers):
            if m.type == 'ARMATURE':
                o.modifiers.remove(m)
        if o.parent and o.parent.type == 'ARMATURE':
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
clear_non_mesh()
for o in bpy.data.objects:
    if o.data.shape_keys:
        o.shape_key_clear()

def join(names, new_name):
    objs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = new_name
    return o

_t = bpy.data.objects['Tank_Turret']
_tb = [_t.matrix_world @ mathutils.Vector(c) for c in _t.bound_box]
turret_centre = mathutils.Vector(((min(v.x for v in _tb) + max(v.x for v in _tb)) / 2, (min(v.y for v in _tb) + max(v.y for v in _tb)) / 2, min(v.z for v in _tb)))
hull = join(['Tank_body', 'TrackMesh.L', 'TrackMesh.R'], 'Hull')
turret = join(['Tank_Turret', 'Tank_Gun'], 'Turret')

# Blender tank faces -X. Rotate so it faces -Y in Blender (=> -Z forward... after Y-up export, Blender -Y becomes +Z)
# glTF export maps Blender (x,y,z) -> (x, z, -y). PlayCanvas forward is -Z, i.e. Blender +Y.
# So rotate tank so the gun points to Blender +Y: rotate -X -> +Y = -90 deg about Z.
rot = mathutils.Matrix.Rotation(math.radians(-90), 4, 'Z')
# measure length for scale
bb = [hull.matrix_world @ mathutils.Vector(c) for c in hull.bound_box]
length = max(v.x for v in bb) - min(v.x for v in bb)
s = TANK_LENGTH / length
S = mathutils.Matrix.Scale(s, 4)
for o in (hull, turret):
    o.data.transform(S @ rot)
    o.data.update()

pivot = (S @ rot) @ turret_centre

turret.data.transform(mathutils.Matrix.Translation(-pivot))
turret.location = pivot
turret.parent = hull

# hull origin at ground contact centre
hb = [v.co for v in hull.data.vertices]
hc = mathutils.Vector(((min(v.x for v in hb) + max(v.x for v in hb)) / 2, (min(v.y for v in hb) + max(v.y for v in hb)) / 2, min(v.z for v in hb)))
hull.data.transform(mathutils.Matrix.Translation(-hc))
turret.location -= hc
for o in (hull, turret):
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
bpy.ops.object.select_all(action='DESELECT')
export_glb(f"{OUT}/tank.glb")
tb = [turret.matrix_world @ v.co for v in turret.data.vertices]
print("TANK scale", s, "turret pivot (blender)", tuple(turret.location),
      "turret top", max(v.z for v in tb), "gun tip y", max(v.y for v in tb),
      "hull size", [round(max(v[i] for v in [x.co for x in hull.data.vertices]) - min(v[i] for v in [x.co for x in hull.data.vertices]), 2) for i in range(3)])
