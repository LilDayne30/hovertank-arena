import bpy, sys, math, mathutils
a = sys.argv[sys.argv.index('--')+1:]
path, out = a[0], a[1]
bpy.ops.wm.open_mainfile(filepath=path)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'MATERIAL'
sc.render.resolution_x = 900; sc.render.resolution_y = 700
cam = bpy.data.objects.get('Camera') or bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
if cam.name not in sc.objects: sc.collection.objects.link(cam)
sc.camera = cam
views = {'top': ((0,0,60), (0,0,0)), 'persp': ((26,-26,22),(0,0,0)), 'low': ((0,-9,2.5),(0,8,0))}
for name,(pos,tgt) in views.items():
    cam.location = pos
    d = mathutils.Vector(tgt) - mathutils.Vector(pos)
    cam.rotation_euler = d.to_track_quat('-Z','Y').to_euler()
    cam.data.type = 'ORTHO' if name=='top' else 'PERSP'
    cam.data.ortho_scale = 48
    cam.data.lens = 24 if name=='low' else 35
    sc.render.filepath = f"{out}_{name}.png"
    bpy.ops.render.render(write_still=True)
