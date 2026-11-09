#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install="$root/runtime"
mkdir -p "$install/bin"
mkdir -p "$install/reference"
command -v cc >/dev/null || { echo 'Install a C compiler (Xcode command line tools on macOS; build-essential on Linux/WSL).' >&2; exit 1; }
for tool in ffmpeg ffprobe cmake git curl; do
  command -v "$tool" >/dev/null || { echo "Install $tool first (macOS: brew install ffmpeg cmake; Ubuntu/WSL: sudo apt install build-essential ffmpeg cmake git curl)." >&2; exit 1; }
done
flags=(-std=c11 -O3 -Wall -Wextra -pthread)
if [[ "$(uname -s)" == Darwin ]]; then
  if [[ "$(uname -m)" == arm64 ]]; then flags+=(-mcpu=apple-m1); else flags+=(-march=native); fi
  flags+=(-framework Accelerate)
else flags+=(-march=native -lm); fi
cc "$root/native/worker.c" "${flags[@]}" -o "$install/bin/dopplercrack"
"$install/bin/dopplercrack" --version
types_source='https://raw.githubusercontent.com/Mictronics/readsb/2b96fefd0baac3639381c7c0609c9383c7c5bba9/webapp/src/db/types.json'
curl --fail --location --retry 2 --silent --show-error "$types_source" -o "$install/reference/types.json.tmp"
mv "$install/reference/types.json.tmp" "$install/reference/types.json"
printf '%s\n' "$types_source" > "$install/reference/types-source.txt"
relocated_python=false
if [[ -f "$install/python/bin/activate" ]] && ! grep -Fq "$install/python" "$install/python/bin/activate"; then relocated_python=true; fi
if [[ ! -x "$install/python/bin/python" || "$relocated_python" == true ]]; then python3 -m venv "$install/python"; fi
pip_flags=(--quiet)
if [[ "$relocated_python" == true ]]; then pip_flags+=(--force-reinstall); fi
"$install/python/bin/python" -m pip install "${pip_flags[@]}" 'yt-dlp[default]==2026.10.21'
"$install/python/bin/python" "$root/scripts/prepare-doppler-places.py"
if [[ "${1:-}" != --no-language ]]; then
  if [[ ! -f "$install/whisper/CMakeLists.txt" ]]; then
    git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp.git "$install/whisper"
  fi
  cache="$install/whisper/build/CMakeCache.txt"
  if [[ -f "$cache" ]] && ! grep -Fqx "CMAKE_HOME_DIRECTORY:INTERNAL=$install/whisper" "$cache"; then
    # Regenerate location-dependent build files while preserving the old cache.
    mv -- "$cache" "$install/whisper/build/CMakeCache.before-relocation.txt"
  fi
  cmake -S "$install/whisper" -B "$install/whisper/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
  cmake --build "$install/whisper/build" --config Release -j 8 --target whisper-cli
  if [[ ! -f "$install/whisper/models/ggml-tiny.bin" ]]; then
    bash "$install/whisper/models/download-ggml-model.sh" tiny
  fi
fi
echo 'Dopplercrack ready. Native C search, FFmpeg, and local language recognition are independent of the AI brief endpoint.'
