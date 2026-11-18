"""Independent verification of exported images. Usage: verify_image.py manifest.json
Each entry: {file, format, size:[w,h], pixels:[{xy:[x,y], rgb:[r,g,b], tol}], max_bytes?, alpha_opaque?}"""
import json, sys
from PIL import Image
m = json.load(open(sys.argv[1])); fail = 0
for e in m:
    name = e["name"]; errs = []
    try:
        with Image.open(e["file"]) as im:
            im.verify()                       # structural integrity
        im = Image.open(e["file"]); im.load() # full decode
        if e.get("format") and im.format != e["format"]: errs.append(f"format {im.format} != {e['format']}")
        if e.get("size") and list(im.size) != e["size"]: errs.append(f"size {list(im.size)} != {e['size']}")
        if e.get("mode") and im.mode != e["mode"]: errs.append(f"mode {im.mode} != {e['mode']}")
        rgb = im.convert("RGB")
        for p in e.get("pixels", []):
            got = rgb.getpixel(tuple(p["xy"])); tol = p.get("tol", 4)
            if any(abs(a - b) > tol for a, b in zip(got, p["rgb"])): errs.append(f"pixel {p['xy']} {got} != {p['rgb']} (±{tol})")
        if e.get("max_bytes") and e["bytes"] > e["max_bytes"]: errs.append(f"bytes {e['bytes']} > {e['max_bytes']}")
        if e.get("min_bytes") and e["bytes"] < e["min_bytes"]: errs.append(f"bytes {e['bytes']} < {e['min_bytes']}")
    except Exception as ex:
        errs.append(f"cannot open: {ex}")
    print(("PASS " if not errs else "FAIL ") + name + (" :: " + "; ".join(errs) if errs else f"  [{e.get('bytes','?')} B]"))
    fail += bool(errs)
print(f"\nPIL verification: {len(m)-fail} passed, {fail} failed")
sys.exit(1 if fail else 0)
