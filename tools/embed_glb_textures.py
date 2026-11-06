# Put the external textures a .glb refers to (images[].uri) inside the file, so it loads from a blob URL.
#   python3 tools/embed_glb_textures.py public/assets/stages/foundry/*.glb
import sys, struct, json, os

def pad4(b, fill=b'\0'):
    return b + fill * ((4 - len(b) % 4) % 4)

for path in sys.argv[1:]:
    data = open(path, 'rb').read()
    assert data[:4] == b'glTF'
    jlen = struct.unpack('<I', data[12:16])[0]
    j = json.loads(data[20:20 + jlen])
    rest = data[20 + jlen:]
    binc = b''
    if rest:
        blen = struct.unpack('<I', rest[:4])[0]
        binc = rest[8:8 + blen]
    changed = False
    for img in j.get('images', []):
        uri = img.get('uri')
        if not uri or uri.startswith('data:'):
            continue
        png = open(os.path.join(os.path.dirname(path), uri), 'rb').read()
        binc = pad4(binc)
        j.setdefault('bufferViews', []).append({'buffer': 0, 'byteOffset': len(binc), 'byteLength': len(png)})
        img.pop('uri'); img['bufferView'] = len(j['bufferViews']) - 1; img['mimeType'] = 'image/png'
        binc += png
        changed = True
    if not changed:
        continue
    binc = pad4(binc)
    j['buffers'][0]['byteLength'] = len(binc)
    js = pad4(json.dumps(j, separators=(',', ':')).encode(), b' ')
    out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(binc)) + struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(binc)) + b'BIN\0' + binc
    open(path, 'wb').write(out)
    print('embedded', path, len(out))
