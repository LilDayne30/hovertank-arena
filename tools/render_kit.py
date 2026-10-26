# Preview renders of the tank kit (workbench, no textures): one image per combination.
#   python3 -I tools/render_kit.py -- <tank.glb> <outdir> "std,none,none" "twin,spoiler,skirt" ...
# Each combination is turret,rear,side. Outline shells are shown pushed out along their normals.
import bpy, sys, math, mathutils
a = sys.argv[sys.argv.index('--') + 1:]
GLB, OUT, combos = a[0], a[1], a[2:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
paint = {'Main': (0.75, 0.2, 0.15), 'Main_Dark': (0.5, 0.13, 0.1), 'Main_Light': (0.9, 0.3, 0.22), 'Main_Details': (0.1, 0.1, 0.09),
         'Wheels': (0.05, 0.05, 0.04), 'Glow': (0.3, 0.85, 1), 'Gold': (0.95, 0.72, 0.2), 'Outline': (1, 0.1, 0.1)}
for m in bpy.data.materials:
    base = m.name.split('.')[0]
    if base in paint: m.diffuse_color = (*paint[base], 1)
for o in bpy.data.objects:
    if o.type == 'MESH' and o.name.endswith('_ol'):
        o.data.flip_normals()
        d = o.modifiers.new('push', 'DISPLACE'); d.strength = -0.05; d.mid_level = 0   # flipped normals point inward
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'MATERIAL'; sc.display.shading.show_backface_culling = True
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new('w'); sc.display.shading.background_type = 'VIEWPORT'
sc.render.resolution_x, sc.render.resolution_y = 480, 360
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 6.4
groups = {o.name: o for o in bpy.data.objects if o.type == 'EMPTY' and o.name[:2] in ('T_', 'R_', 'S_')}
def show(o, on):
    o.hide_render = not on
    for c in o.children_recursive: c.hide_render = not on
for i, c in enumerate(combos):
    t, r, s = c.split(',')
    for n, g in groups.items():
        show(g, n in (f'T_{t}', f'R_{r}', f'S_{s}'))
    for view, pos in (('a', (-7, 6.5, 4.2)), ('b', (6.5, -7, 3.6))):
        p = mathutils.Vector(pos); tgt = mathutils.Vector((0, 0, 1.0))
        cam.location = p; cam.rotation_euler = (tgt - p).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = f'{OUT}/kit_{i}_{view}.png'
        bpy.ops.render.render(write_still=True)
