import bpy, sys, mathutils
a = sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a[0])
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.color_type = 'MATERIAL'
sc.render.resolution_x = 600; sc.render.resolution_y = 450
for o in bpy.data.objects: print(o.name, o.type, tuple(round(v,2) for v in o.location), o.parent.name if o.parent else '-')
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 7
# Blender after import: glTF -Z (game forward) == Blender +Y
for name, pos in {'top': (0, 0, 20), 'side': (20, 0, 1)}.items():
    cam.location = pos
    cam.rotation_euler = (mathutils.Vector((0, 0, 0.8)) - mathutils.Vector(pos)).to_track_quat('-Z', 'Y' if name=='top' else 'Z').to_euler()
    sc.render.filepath = f"{a[1]}_{name}.png"; bpy.ops.render.render(write_still=True)
