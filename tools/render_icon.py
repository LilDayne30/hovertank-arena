# Render the tank (red) from a 3/4 view on a transparent background for the app icon.
#   python3 -I tools/render_icon.py -- public/assets/tank.glb out.png
import bpy, sys, math, mathutils
a = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a[0])
for m in bpy.data.materials:
    # the workbench renderer uses the viewport colour (diffuse_color), not the node tree
    if m.name.startswith('Main'):
        base = m.name.split('.')[0]
        shade = {'Main_Dark': 0.55, 'Main_Light': 1.2, 'Main_Details': 0.28}.get(base, 0.85)
        m.diffuse_color = (min(1, 0.80 * shade), 0.10 * shade, 0.06 * shade, 1)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'MATERIAL'
sc.display.shading.show_shadows = False
sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 1024
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 5.6
pos = mathutils.Vector((-7, -5.5, 3.6)); tgt = mathutils.Vector((0, 0.2, 0.8))
cam.location = pos
cam.rotation_euler = (tgt - pos).to_track_quat('-Z', 'Y').to_euler()
sc.render.filepath = a[1]
bpy.ops.render.render(write_still=True)
