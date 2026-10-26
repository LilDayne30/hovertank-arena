#!/usr/bin/env bash
# Rebuild game assets from the original .blend sources.
#   tools/build_assets.sh <arena.blend> <Tank3.blend>
# Only the tank kit (no .blend needed):  tools/build_assets.sh --kit
# Requires: pip install bpy==5.2.3 (Blender as a Python module), npm deps (gltf-transform).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/assets
mkdir -p "$OUT" tools/.tmp tools/src
if [ "${1:-}" = "--kit" ]; then
  python3 -I tools/build_parts.py -- tools/src/tank_base.glb tools/.tmp/tank_kit.glb
  npx -y @gltf-transform/cli@4.5.1 weld tools/.tmp/tank_kit.glb tools/.tmp/tank_kit.w.glb
  npx -y @gltf-transform/cli@4.5.1 quantize tools/.tmp/tank_kit.w.glb "$OUT/tank.glb"
  ls -la "$OUT"; exit 0
fi
python3 -I tools/build_assets.py -- "$1" "$2" tools/.tmp
cp tools/.tmp/arena_hf.bin tools/.tmp/arena_hf.json "$OUT/"
cp tools/.tmp/tank.glb tools/src/tank_base.glb
# cosmetic kit (turrets, rear/side parts, outlines, pattern UVs) on top of the base tank
python3 -I tools/build_parts.py -- tools/src/tank_base.glb tools/.tmp/tank_kit.glb
mv tools/.tmp/tank_kit.glb tools/.tmp/tank.glb
for f in arena tank; do
  npx -y @gltf-transform/cli@4.5.1 weld tools/.tmp/$f.glb tools/.tmp/$f.w.glb
  npx -y @gltf-transform/cli@4.5.1 quantize tools/.tmp/$f.w.glb "$OUT/$f.glb"
done
ls -la "$OUT"
