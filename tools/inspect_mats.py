import bpy, sys
bpy.ops.wm.open_mainfile(filepath=sys.argv[sys.argv.index('--')+1])
for m in bpy.data.materials:
    info=[]
    if m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type=='BSDF_PRINCIPLED': info.append(('bsdf', [round(c,3) for c in n.inputs['Base Color'].default_value], n.inputs['Base Color'].is_linked))
            elif n.type=='TEX_IMAGE': info.append(('img', n.image.name if n.image else None, n.image.filepath if n.image else None))
    print(m.name, [round(c,3) for c in m.diffuse_color], info)
