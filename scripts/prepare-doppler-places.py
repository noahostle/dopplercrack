"""Install a compact, offline GeoNames gazetteer. No runtime geocoding API."""
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

target = Path(__file__).resolve().parent.parent / "runtime" / "reference" / "places.json"
if target.is_file() and "--refresh" not in sys.argv:
    print("Offline place names already installed.")
    sys.exit(0)

base = "https://download.geonames.org/export/dump/"
sources = {}


def download(name):
    request = urllib.request.Request(base + name, headers={"User-Agent": "Dopplercrack/0.5 gazetteer-installer"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError("Gazetteer download exceeds expected size")
    sources[name] = hashlib.sha256(data).hexdigest()
    return data


admins = {}
for line in download("admin1CodesASCII.txt").decode("utf-8").splitlines():
    fields = line.split("\t")
    if len(fields) >= 2:
        admins[fields[0]] = fields[1]

cities = []
with zipfile.ZipFile(io.BytesIO(download("cities1000.zip"))) as archive:
    info = archive.getinfo("cities1000.txt")
    if info.file_size > 100 * 1024 * 1024:
        raise ValueError("Unexpected gazetteer size")
    with archive.open(info) as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8"):
            fields = line.rstrip("\n").split("\t")
            if len(fields) >= 19 and fields[6] == "P" and fields[8]:
                cities.append([fields[1], round(float(fields[4]), 5), round(float(fields[5]), 5), fields[8], fields[10]])
if len(cities) < 100000:
    raise ValueError("Incomplete GeoNames gazetteer")
target.parent.mkdir(parents=True, exist_ok=True)
payload = {"version": 1, "source": base, "license": "CC BY 4.0", "retrievedAt": datetime.now(timezone.utc).isoformat(), "sha256": sources, "admins": admins, "cities": cities}
temporary = target.with_suffix(".json.tmp")
temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
temporary.replace(target)
print(f"Installed {len(cities):,} offline place names ({target.stat().st_size / 1048576:.1f} MiB).")
