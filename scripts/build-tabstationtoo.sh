#!/usr/bin/env bash
# Builds TabStationToo (PCSX2 compiled to WebAssembly, GPL-3.0) at one commit and packs the
# static site LootDen serves for PS2 games in the browser.
#
#   scripts/build-tabstationtoo.sh <out.tar.gz> [commit]
#
# The commit defaults to the one pinned in emulators/tabstationtoo.env. Needs git, CMake 4.x,
# Ninja and Python 3; Emscripten is installed into $EMSDK (default ~/emsdk) at the pinned
# version when it isn't there. The tarball holds the site, TabStationToo's licence and a
# SOURCE.txt naming the exact source it was built from (GPL-3.0, section 6).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../emulators/tabstationtoo.env
. "$here/emulators/tabstationtoo.env"
out="$(realpath -m "${1:?usage: build-tabstationtoo.sh <out.tar.gz> [commit]}")"
commit="${2:-$TABSTATIONTOO_COMMIT}"
emsdk="${EMSDK:-$HOME/emsdk}"
work="${TABSTATIONTOO_WORK:-$(mktemp -d)}"

if [ ! -x "$emsdk/emsdk" ]; then
  git init -q "$emsdk"
  git -C "$emsdk" fetch -q --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_COMMIT"
  git -C "$emsdk" checkout -q --detach FETCH_HEAD
fi
"$emsdk/emsdk" install "$EMSCRIPTEN_VERSION" >/dev/null
"$emsdk/emsdk" activate "$EMSCRIPTEN_VERSION" >/dev/null
# shellcheck disable=SC1091
source "$emsdk/emsdk_env.sh" >/dev/null 2>&1

src="$work/src"
if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null)" != "$commit" ]; then
  rm -rf "$src"
  git init -q "$src"
  git -C "$src" fetch -q --depth 1 "$TABSTATIONTOO_REPO" "$commit"
  git -C "$src" checkout -q --detach FETCH_HEAD
fi
test "$(git -C "$src" rev-parse HEAD)" = "$commit"

cd "$src"
[ -d deps-wasm ] || EM_COMPILER_WRAPPER="" tools/wasm/build-dependencies-wasm.sh deps-wasm
emcmake cmake -B build-wasm -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_TESTS=OFF \
  -DCMAKE_PREFIX_PATH="$PWD/deps-wasm" -DCMAKE_FIND_ROOT_PATH="$PWD/deps-wasm" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
ninja -C build-wasm pcsx2-wasm 2>&1 | tee build.log
# wasm-ld turns calls with mismatched signatures into traps (TabStationToo's AGENTS.md).
if grep -n "signature mismatch" build.log; then
  echo "The link reported signature mismatches" >&2
  exit 1
fi

rm -rf _site
python3 tools/wasm/assemble-site.py --out _site
cp COPYING.GPLv3 _site/COPYING.GPLv3
cat > _site/SOURCE.txt <<TXT
TabStationToo: PCSX2 compiled to WebAssembly, free software under the GNU GPL v3.0
(COPYING.GPLv3 beside this file).

Built without changes from:
  $TABSTATIONTOO_REPO
  commit $commit

with Emscripten $EMSCRIPTEN_VERSION, by LootDen's scripts/build-tabstationtoo.sh.
TXT
mkdir -p "$(dirname "$out")"
tar -czf "$out" -C _site .
echo "Wrote $out"
