#!/usr/bin/env bash
# Rebuild game assets from the original .blend sources.
#   tools/build_assets.sh <arena.blend> <Tank3.blend>
# Requires: pip install bpy==5.2.3 (Blender as a Python module), npm deps (gltf-transform).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/assets
mkdir -p "$OUT" tools/.tmp
python3 -I tools/build_assets.py -- "$1" "$2" tools/.tmp
cp tools/.tmp/arena_hf.bin tools/.tmp/arena_hf.json "$OUT/"
for f in arena tank; do
  npx -y @gltf-transform/cli@4.5.1 weld tools/.tmp/$f.glb tools/.tmp/$f.w.glb
  npx -y @gltf-transform/cli@4.5.1 quantize tools/.tmp/$f.w.glb "$OUT/$f.glb"
done
ls -la "$OUT"
