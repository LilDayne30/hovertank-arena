# Cosmetic tank kit: turrets, rear / side parts, outline shells and pattern UVs.
#   python3 -I tools/build_parts.py -- <tank_base.glb> <out.glb>
# Input is the tank made by build_assets.py (before weld/quantize; a copy lives in tools/src/).
# Output nodes (Blender: +Y = forward, +Z = up; glTF export turns that into -Z forward, +Y up):
#   Hull, Hull_ol                       hull mesh + its outline shell
#   T_<id>  (empty at the turret pivot) -> T_<id>_m (mesh), T_<id>_ol (outline)   rotated by the game
#   R_<id>, S_<id> (empties at the hull origin) -> *_m, *_ol                         rear / side parts
# The pivot empties keep the rotation centre even after gltf-transform quantize (which moves the
# origin of mesh nodes to their bounding box).
# Materials: Main / Main_Dark / Main_Light = paint (+ pattern), Main_Details / Wheels = dark metal,
# Glow = emissive (tinted by the player's glow colour), Gold = fixed, Outline = replaced at runtime.
import bpy, bmesh, sys, math, mathutils
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = args[0], args[1]
# pattern UVs: box projection of the part's own coordinates, mapped so +-3 m fits in [0, 1]
# (+-4 m fits in [0, 1], keeps them quantizable); the client repeats the pattern texture UV_SPAN / 2.4 times (one tile = 2.4 m)
UV_SPAN = 8.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
hull = bpy.data.objects['Hull']; turret = bpy.data.objects['Turret']
PIVOT = turret.matrix_world.translation.copy()
for o in (hull, turret):
    o.data = o.data.copy()
    mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
mats = {m.name: m for m in bpy.data.materials}


def material(name, color, emit=None):
    if name in mats: return mats[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Metallic'].default_value = 0; b.inputs['Roughness'].default_value = 0.8
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = 1.0
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    m.use_backface_culling = True
    mats[name] = m
    return m

material('Main_Light', (0.24, 0.21, 0.22))
material('Glow', (0.3, 0.8, 1.0), emit=(0.3, 0.8, 1.0))
material('Gold', (0.92, 0.7, 0.22))
material('Outline', (0, 0, 0))


# ------------------------------------------------------------------ tiny low-poly modelling kit
class Part:
    def __init__(self):
        self.bm = bmesh.new(); self.slots = []

    def mi(self, name):
        if name not in self.slots: self.slots.append(name)
        return self.slots.index(name)

    def hull(self, pts, mat, xf=None):
        """convex hull of the given points (the basic building block)"""
        vs = [self.bm.verts.new((xf @ Vector(p)) if xf else Vector(p)) for p in pts]
        res = bmesh.ops.convex_hull(self.bm, input=vs, use_existing_faces=False)
        junk = list({g for g in res['geom_interior'] + res['geom_unused'] if isinstance(g, bmesh.types.BMVert)})
        if junk: bmesh.ops.delete(self.bm, geom=junk, context='VERTS')
        idx = self.mi(mat)
        for g in res['geom']:
            if isinstance(g, bmesh.types.BMFace): g.material_index = idx
        return self

    def box(self, x0, x1, y0, y1, z0, z1, mat, ch=0.0, xf=None):
        x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1)); z0, z1 = sorted((z0, z1))
        pts = []
        for x in (x0, x1):
            for y in (y0, y1):
                for z in (z0, z1):
                    if ch <= 0: pts.append((x, y, z)); continue
                    sx, sy, sz = (1 if x == x1 else -1), (1 if y == y1 else -1), (1 if z == z1 else -1)
                    pts += [(x - sx * ch, y, z), (x, y - sy * ch, z), (x, y, z - sz * ch)]
        return self.hull(pts, mat, xf)

    def cyl(self, c, axis, r, a0, a1, mat, seg=8, r1=None, xf=None, rot=0.0):
        """cylinder (or cone when r1 is given) along axis 'x' | 'y' | 'z' from a0 to a1"""
        r1 = r if r1 is None else r1
        pts = []
        for a, rr in ((a0, r), (a1, r1)):
            for i in range(seg):
                t = rot + i / seg * math.tau
                u, v = math.cos(t) * rr, math.sin(t) * rr
                if rr <= 1e-4: u = v = 0
                p = {'x': (a, c[0] + u, c[1] + v), 'y': (c[0] + u, a, c[1] + v), 'z': (c[0] + u, c[1] + v, a)}[axis]
                pts.append(p)
                if rr <= 1e-4: break
        return self.hull(pts, mat, xf)

    def mirror_x(self, fn):
        """call fn(sign) for +x and -x"""
        fn(1); fn(-1); return self

    def object(self, name, origin=(0, 0, 0)):
        me = bpy.data.meshes.new(name)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        self.bm.to_mesh(me); self.bm.free()
        for s in self.slots: me.materials.append(mats[s])
        for p in me.polygons: p.use_smooth = False
        o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
        o.location = origin
        return o


def box_uvs(o):
    """box projection: each face takes the two axes perpendicular to its dominant normal"""
    me = o.data
    uv = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        n = p.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u, v = [(co.y, co.z), (co.x, co.z), (co.x, co.y)][ax]
            uv.data[li].uv = (u / UV_SPAN + 0.5, v / UV_SPAN + 0.5)


def outline(o, ratio=1.0, drop=()):
    """smooth-normal copy used as an inverted hull (pushed out along its normals by the shader)"""
    bm = bmesh.new(); bm.from_mesh(o.data)
    if drop:
        names = [m.name for m in o.data.materials]
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if names[f.material_index] in drop], context='FACES')
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.004)
    me = bpy.data.meshes.new(o.name + '_ol'); bm.to_mesh(me); bm.free()
    while me.uv_layers: me.uv_layers.remove(me.uv_layers[0])
    me.materials.clear(); me.materials.append(mats['Outline'])
    for p in me.polygons: p.material_index = 0
    ol = bpy.data.objects.new(o.name.replace('_m', '') + '_ol', me); bpy.context.scene.collection.objects.link(ol)
    ol.matrix_world = o.matrix_world.copy()
    if ratio < 1:
        d = ol.modifiers.new('dec', 'DECIMATE'); d.ratio = ratio
        bpy.context.view_layer.objects.active = ol
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ol.evaluated_get(dg)); ol.modifiers.clear(); ol.data = me2
        me2.materials.clear(); me2.materials.append(mats['Outline'])
    for p in ol.data.polygons: p.use_smooth = True
    for e in ol.data.edges: e.use_edge_sharp = False
    return ol


def group(name, mesh, origin, ol_ratio=1.0):
    """empty at origin -> mesh + outline children (mesh vertices relative to origin)"""
    e = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(e)
    e.location = origin
    mesh.name = name + '_m'
    mesh.location = (0, 0, 0); mesh.parent = e
    box_uvs(mesh)
    ol = outline(mesh, ol_ratio); ol.name = name + '_ol'; ol.parent = e; ol.matrix_parent_inverse = Matrix.Identity(4); ol.location = (0, 0, 0)
    return e


# ------------------------------------------------------------------ hull & original turret
hull.name = 'Hull'
hol = outline(hull, ratio=0.18, drop=('Wheels',)); hol.name = 'Hull_ol'
# the dark running gear never shows a pattern: split it off so it carries no UVs
bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active = hull; hull.select_set(True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT')
for i, m in enumerate(hull.data.materials):
    if m.name in ('Main_Details', 'Wheels'):
        hull.active_material_index = i; bpy.ops.object.material_slot_select()
bpy.ops.mesh.separate(type='SELECTED'); bpy.ops.object.mode_set(mode='OBJECT')
gear = [o for o in bpy.context.selected_objects if o is not hull][0]; gear.name = 'Hull_gear'
for o in (hull, gear):   # drop material slots the piece no longer uses
    used = {p.material_index for p in o.data.polygons}
    for i in reversed(range(len(o.data.materials))):
        if i not in used: o.active_material_index = i; bpy.context.view_layer.objects.active = o; bpy.ops.object.material_slot_remove()
box_uvs(hull)
# wheels sit inside the tracks and are nearly black: a much coarser version looks the same
bm = bmesh.new(); bm.from_mesh(gear.data)
wi = [i for i, m in enumerate(gear.data.materials) if m.name == 'Wheels']
if wi:
    d = gear.modifiers.new('dec', 'DECIMATE'); d.ratio = 0.3
    gear.vertex_groups.new(name='w').add([v.index for p in gear.data.polygons if p.material_index == wi[0] for v in [gear.data.vertices[i] for i in p.vertices]], 1.0, 'REPLACE')
    d.vertex_group = 'w'
    bpy.context.view_layer.objects.active = gear
    bpy.ops.object.modifier_apply(modifier='dec')
    gear.vertex_groups.clear()
bm.free()
std = turret                               # its vertices are already relative to the pivot
group('T_std', std, PIVOT, 0.6)

# ------------------------------------------------------------------ turrets (local frame: pivot at origin)
# reference: original turret body x +-0.78, y -0.74..0.74, z 0..1.04; barrel axis z 0.59, tip y 2.19
BZ = 0.59
def t_twin():
    p = Part()
    p.box(-0.78, 0.78, -0.85, 0.55, 0.08, 0.85, 'Main_Dark', ch=0.12)
    p.box(-0.6, 0.6, -0.62, 0.38, 0.84, 0.96, 'Main', ch=0.05)
    p.box(-0.52, 0.52, 0.5, 0.86, 0.3, 0.84, 'Main', ch=0.06)
    p.box(-0.55, 0.55, -1.12, -0.82, 0.25, 0.72, 'Main_Details', ch=0.04)
    for s in (1, -1):
        p.cyl((0.22 * s, BZ), 'y', 0.085, 0.8, 2.08, 'Main_Light')
        p.cyl((0.22 * s, BZ), 'y', 0.125, 2.0, 2.26, 'Main_Details')
        p.cyl((0.22 * s, BZ), 'y', 0.12, 0.8, 1.05, 'Main_Details')
    p.cyl((-0.28, -0.25), 'z', 0.22, 0.95, 1.06, 'Main_Details')
    return p.object('twin')

def t_long():
    p = Part()
    p.hull([(sx * 0.72, -0.85, z) for sx in (1, -1) for z in (0.08, 0.78)] + [(sx * 0.5, 0.62, z) for sx in (1, -1) for z in (0.14, 0.62)], 'Main_Dark')
    p.box(-0.5, 0.5, -0.6, 0.3, 0.77, 0.86, 'Main', ch=0.04)
    p.cyl((0, BZ - 0.04), 'y', 0.13, 0.45, 1.15, 'Main', seg=8)
    p.cyl((0, BZ - 0.04), 'y', 0.075, 1.1, 2.62, 'Main_Light')
    p.box(-0.14, 0.14, 2.4, 2.66, BZ - 0.13, BZ + 0.05, 'Main_Details', ch=0.03)
    p.box(0.25, 0.42, -0.2, 0.42, 0.85, 1.0, 'Main_Details', ch=0.02)
    p.box(0.28, 0.39, 0.42, 0.45, 0.88, 0.97, 'Glow')
    return p.object('long')

def t_heavy():
    p = Part()
    p.hull([(sx * 0.98, y, 0.06) for sx in (1, -1) for y in (-1.0, 0.62)] + [(sx * 0.78, y, 1.02) for sx in (1, -1) for y in (-0.85, 0.3)], 'Main_Dark')
    p.mirror_x(lambda s: p.hull([(s * 0.25, 0.6, 0.2), (s * 0.95, 0.55, 0.2), (s * 0.25, 0.86, 0.3), (s * 0.85, 0.75, 0.3),
                                 (s * 0.25, 0.6, 0.95), (s * 0.78, 0.35, 0.95), (s * 0.25, 0.78, 0.85), (s * 0.7, 0.55, 0.85)], 'Main'))
    p.cyl((0, BZ), 'y', 0.2, 0.6, 1.0, 'Main_Details', seg=8)
    p.cyl((0, BZ), 'y', 0.17, 0.9, 1.9, 'Main_Light', seg=8)
    p.box(-0.28, 0.28, 1.85, 2.27, BZ - 0.21, BZ + 0.21, 'Main_Details', ch=0.05)
    for x in (-0.45, 0.45):
        p.box(x - 0.18, x + 0.18, -0.7, -0.25, 1.0, 1.08, 'Main_Details', ch=0.02)
    return p.object('heavy')

def t_rail():
    p = Part()
    p.box(-0.76, 0.76, -0.88, 0.5, 0.06, 0.56, 'Main_Dark', ch=0.1)
    p.box(-0.5, 0.5, -0.7, 0.2, 0.55, 0.66, 'Main', ch=0.04)
    for s in (1, -1):
        p.box(s * 0.14, s * 0.3, 0.1, 2.45, 0.4, 0.74, 'Main_Light', ch=0.03)
    p.box(-0.075, 0.075, 0.2, 2.38, 0.5, 0.64, 'Glow')
    for y in (0.75, 1.3, 1.85):
        p.box(-0.36, 0.36, y, y + 0.14, 0.34, 0.8, 'Main_Details', ch=0.03)
    p.box(-0.42, 0.42, -0.95, -0.8, 0.18, 0.46, 'Glow')
    return p.object('rail')

def t_king():
    p = Part()
    p.cyl((0, 0), 'z', 0.86, 0.06, 0.74, 'Main_Dark', seg=8, rot=math.pi / 8)
    p.cyl((0, 0), 'z', 0.7, 0.73, 0.9, 'Main', seg=8, rot=math.pi / 8, r1=0.6)
    p.cyl((0, 0), 'z', 0.885, 0.42, 0.54, 'Gold', seg=8, rot=math.pi / 8)
    for i in range(8):
        a = i / 8 * math.tau
        cx, cy = math.cos(a) * 0.56, math.sin(a) * 0.56
        p.hull([(cx + math.cos(a + d) * 0.13, cy + math.sin(a + d) * 0.13, 0.86) for d in (0, math.pi / 2, math.pi, 3 * math.pi / 2)] + [(cx * 1.05, cy * 1.05, 1.26)], 'Gold')
    p.cyl((0, BZ), 'y', 0.13, 0.55, 1.0, 'Gold')
    p.cyl((0, BZ), 'y', 0.09, 0.9, 2.42, 'Main_Light')
    p.cyl((0, BZ), 'y', 0.125, 1.55, 1.68, 'Gold')
    p.cyl((0, BZ), 'y', 0.14, 2.2, 2.46, 'Gold')
    return p.object('king')

def t_dome():
    p = Part()
    pts = []
    for ring in range(5):
        el = ring / 4 * (math.pi / 2) * 0.92
        for i in range(10):
            a = i / 10 * math.tau + ring * 0.3
            pts.append((math.cos(a) * math.cos(el) * 0.86, math.sin(a) * math.cos(el) * 0.86 - 0.05, 0.12 + math.sin(el) * 0.82))
    p.hull(pts, 'Main_Dark')
    p.cyl((0, -0.05), 'z', 0.9, 0.08, 0.24, 'Glow', seg=10)
    p.cyl((0, BZ), 'y', 0.16, 0.55, 0.95, 'Main', seg=8)
    p.cyl((0, BZ), 'y', 0.1, 0.9, 2.2, 'Main_Light')
    p.cyl((0, BZ), 'y', 0.14, 2.05, 2.24, 'Main_Details')
    p.box(-0.42, -0.24, 0.6, 0.72, 0.62, 0.78, 'Glow')
    return p.object('dome')

def t_missile():
    p = Part()
    p.box(-0.62, 0.62, -0.78, 0.55, 0.08, 0.8, 'Main_Dark', ch=0.1)
    p.box(-0.45, 0.45, -0.55, 0.3, 0.79, 0.88, 'Main', ch=0.03)
    for s in (1, -1):
        p.box(s * 0.66, s * 1.1, -0.5, 0.55, 0.38, 0.88, 'Main', ch=0.05)
        for dx in (0.77, 0.99):
            for z in (0.52, 0.74):
                p.cyl((s * dx, z), 'y', 0.075, 0.55, 0.62, 'Main_Details')
                p.cyl((s * dx, z), 'y', 0.07, 0.62, 0.74, 'Glow', r1=0.0)
    p.cyl((0, BZ), 'y', 0.085, 0.5, 2.15, 'Main_Light')
    p.cyl((0, BZ), 'y', 0.12, 1.98, 2.2, 'Main_Details')
    return p.object('missile')

for n, fn in [('twin', t_twin), ('long', t_long), ('heavy', t_heavy), ('rail', t_rail), ('king', t_king), ('dome', t_dome), ('missile', t_missile)]:
    group(f'T_{n}', fn(), PIVOT)

# ------------------------------------------------------------------ rear parts (hull frame)
# hull: rear deck z ~1.03 (centre) / 1.12 (fenders x 1.0..1.49), rear face y ~ -2.1, track side x 1.49
def r_spoiler():
    p = Part()
    p.mirror_x(lambda s: p.box(s * 0.68, s * 0.82, -1.98, -1.8, 1.0, 1.58, 'Main_Details', ch=0.02))
    tilt = Matrix.Translation((0, -1.98, 1.6)) @ Matrix.Rotation(math.radians(-8), 4, 'X') @ Matrix.Translation((0, 1.98, -1.6))
    p.box(-1.48, 1.48, -2.28, -1.72, 1.56, 1.64, 'Main', ch=0.02, xf=tilt)
    p.mirror_x(lambda s: p.hull([(s * 1.46, -2.36, 1.38), (s * 1.53, -2.36, 1.38), (s * 1.46, -1.68, 1.42), (s * 1.53, -1.68, 1.42),
                                 (s * 1.46, -2.4, 1.78), (s * 1.53, -2.4, 1.78), (s * 1.46, -1.9, 1.74), (s * 1.53, -1.9, 1.74)], 'Main_Dark'))
    return p.object('spoiler')

def r_fins():
    p = Part()
    def fin(s):
        x0, x1 = s * 1.2, s * 1.29
        prof = [(-2.08, 1.1), (-0.95, 1.12), (-1.72, 1.98), (-2.16, 2.0)]
        p.hull([(x, y, z) for x in (x0, x1) for y, z in prof], 'Main_Dark')
        p.hull([(x, y, z) for x in (s * 1.185, s * 1.305) for y, z in [(-2.17, 1.92), (-1.74, 1.9), (-2.17, 2.02), (-1.72, 2.0)]], 'Glow')
    p.mirror_x(fin)
    return p.object('fins')

def r_jet():
    p = Part()
    def wing(s):
        p.hull([(s * 0.95, y, z) for y in (-1.95, -0.55) for z in (1.12, 1.2)] + [(s * 2.15, y, z) for y in (-2.15, -1.78) for z in (1.22, 1.27)], 'Main')
        p.cyl((s * 0.62, 1.32), 'y', 0.21, -2.22, -1.3, 'Main_Details', seg=8)
        p.cyl((s * 0.62, 1.32), 'y', 0.15, -2.3, -2.2, 'Glow', seg=8)
        p.hull([(s * 2.08, y, z) for y in (-2.2, -1.75) for z in (1.22, 1.62)] + [(s * 2.15, y, z) for y in (-2.2, -1.75) for z in (1.22, 1.62)], 'Main_Dark')
    p.mirror_x(wing)
    return p.object('jet')

def r_antenna():
    p = Part()
    p.cyl((1.15, -1.75), 'z', 0.09, 1.1, 1.26, 'Main_Details', seg=6)
    p.cyl((1.15, -1.75), 'z', 0.028, 1.2, 3.15, 'Main_Details', seg=5)
    p.hull([(x, y, z) for x in (1.14, 1.16) for y, z in [(-1.78, 3.08), (-2.42, 2.98), (-1.78, 2.62), (-2.42, 2.7)]], 'Main_Light')
    p.cyl((1.15, -1.75), 'z', 0.06, 3.12, 3.2, 'Glow', seg=6)
    return p.object('antenna')

def r_exhaust():
    p = Part()
    def pipe(s):
        p.box(s * 0.42, s * 0.68, -1.9, -1.6, 1.0, 1.15, 'Main_Details', ch=0.02)
        p.cyl((s * 0.55, 1.28), 'y', 0.15, -2.32, -1.62, 'Main_Details', seg=8)
        p.cyl((s * 0.55, 1.28), 'y', 0.105, -2.36, -2.3, 'Glow', seg=8)
    p.mirror_x(pipe)
    return p.object('exhaust')

for n, fn in [('spoiler', r_spoiler), ('fins', r_fins), ('jet', r_jet), ('antenna', r_antenna), ('exhaust', r_exhaust)]:
    group(f'R_{n}', fn(), (0, 0, 0))

# ------------------------------------------------------------------ side / front parts
def s_skirt():
    p = Part()
    def side(s):
        for y0, y1 in [(-1.92, -0.72), (-0.62, 0.52), (0.62, 1.62)]:
            p.box(s * 1.5, s * 1.63, y0, y1, 0.3, 1.06, 'Main_Dark', ch=0.03)
        p.box(s * 1.49, s * 1.6, -1.95, 1.66, 1.02, 1.12, 'Main_Details', ch=0.02)
    p.mirror_x(side)
    return p.object('skirt')

def s_blade():
    p = Part()
    p.hull([(sx * 1.58, y, z) for sx in (1, -1) for y, z in [(2.22, 0.12), (2.4, 0.16), (2.04, 0.9), (2.2, 0.94)]], 'Main')
    p.hull([(sx * 1.6, y, z) for sx in (1, -1) for y, z in [(2.38, 0.1), (2.48, 0.12), (2.36, 0.2), (2.46, 0.22)]], 'Main_Details')
    p.mirror_x(lambda s: p.box(s * 0.85, s * 1.02, 1.55, 2.18, 0.42, 0.58, 'Main_Details', ch=0.02))
    return p.object('blade')

def s_pods():
    p = Part()
    def pod(s):
        p.box(s * 1.08, s * 1.56, -1.05, 0.42, 1.3, 1.64, 'Main_Dark', ch=0.06)
        p.box(s * 1.15, s * 1.49, 0.41, 0.46, 1.4, 1.54, 'Glow')
        p.box(s * 1.12, s * 1.52, -0.8, 0.1, 1.63, 1.68, 'Main', ch=0.01)
    p.mirror_x(pod)
    return p.object('pods')

def s_canard():
    p = Part()
    def can(s):
        p.hull([(s * 1.45, y, z) for y in (0.95, 1.65) for z in (1.2, 1.27)] + [(s * 2.0, y, z) for y in (1.18, 1.42) for z in (1.26, 1.3)], 'Main')
        p.hull([(s * 1.95, y, z) for y in (1.15, 1.45) for z in (1.22, 1.36)] + [(s * 2.02, y, z) for y in (1.15, 1.45) for z in (1.22, 1.36)], 'Glow')
    p.mirror_x(can)
    return p.object('canard')

for n, fn in [('skirt', s_skirt), ('blade', s_blade), ('pods', s_pods), ('canard', s_canard)]:
    group(f'S_{n}', fn(), (0, 0, 0))

# ------------------------------------------------------------------ export
for o in bpy.data.objects:
    if o.type == 'MESH':
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        print('MESH', o.name, 'tris', tris)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=False, export_apply=True, export_animations=False,
    export_skins=False, export_morph=False, export_lights=False, export_cameras=False, export_yup=True,
    export_texcoords=True, export_normals=True, export_materials='EXPORT', export_extras=False, export_vertex_color='NONE',
)
print('PIVOT', tuple(PIVOT))
