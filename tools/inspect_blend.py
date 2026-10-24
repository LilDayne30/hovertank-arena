import bpy, sys
path = sys.argv[sys.argv.index('--')+1]
bpy.ops.wm.open_mainfile(filepath=path)
print("FILE", path)
for o in bpy.data.objects:
    bb = [o.matrix_world @ __import__('mathutils').Vector(c) for c in o.bound_box] if o.type=='MESH' else []
    mn = [min(v[i] for v in bb) for i in range(3)] if bb else None
    mx = [max(v[i] for v in bb) for i in range(3)] if bb else None
    nv = len(o.data.vertices) if o.type=='MESH' else 0
    print(f"{o.type:9s} {o.name:30s} parent={o.parent.name if o.parent else '-':20s} verts={nv:6d} mats={[m.name for m in getattr(o.data,'materials',[]) if m] if o.type=='MESH' else ''} min={[round(v,2) for v in mn] if mn else ''} max={[round(v,2) for v in mx] if mx else ''} pbone={o.parent_bone}")
print("ACTIONS", [a.name for a in bpy.data.actions])
print("IMAGES", [(i.name, i.size[:]) for i in bpy.data.images])
