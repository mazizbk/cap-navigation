"""Fabrique la base des parkings de France (gratuit / payant / accès réservé) à partir d'OpenStreetMap.

Entrée  : un fichier « geojsonseq » produit par osmium (voir .github/workflows/parkings.yml).
Sortie  : un petit fichier JSON par carré de 0,1° (environ 8 x 11 km) dans le dossier donné :
            <lat*10>_<lon*10>.json  ->  [[lon, lat, tarif, réservé, clients, places, type, nom], ...]
          tarif : 0 inconnu, 1 gratuit, 2 payant.
L'application ne charge que les carrés autour de la destination.

Usage : python tools/build_parkings.py parkings.geojsonseq dossier_de_sortie
"""
import json
import math
import os
import sys

RESTRICTED = {"private", "no", "permit", "residents", "employees", "delivery", "military", "agricultural", "forestry"}
KINDS = {"underground": "souterrain", "multi-storey": "à étages", "surface": "en surface", "street_side": "le long de la rue", "lane": "le long de la rue", "rooftop": "sur le toit"}


def center(geom):
    """Point moyen d'une géométrie (suffisant pour situer un parking)."""
    pts = []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            pts.append(c)
        else:
            for x in c:
                walk(x)

    walk(geom.get("coordinates") or [])
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def main(src, out):
    cells = {}
    total = 0
    with open(src, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            try:
                feat = json.loads(line)
            except ValueError:
                continue
            tags = feat.get("properties") or {}
            if tags.get("amenity") != "parking":
                continue
            c = center(feat.get("geometry") or {})
            if not c:
                continue
            fee = tags.get("fee")
            access = tags.get("access", "")
            # On ne garde que ce qui apporte une information : tarif connu, accès restreint, ou nom.
            if not fee and not access and not tags.get("name"):
                continue
            try:
                capacity = int(tags.get("capacity", "0"))
            except ValueError:
                capacity = 0
            row = [
                round(c[0], 5), round(c[1], 5),
                1 if fee == "no" else 2 if fee else 0,
                1 if access in RESTRICTED else 0,
                1 if access == "customers" else 0,
                capacity,
                KINDS.get(tags.get("parking", ""), ""),
                tags.get("name", "")[:60],
            ]
            key = "%d_%d" % (math.floor(c[1] * 10), math.floor(c[0] * 10))
            cells.setdefault(key, []).append(row)
            total += 1
    os.makedirs(out, exist_ok=True)
    for key, rows in cells.items():
        with open(os.path.join(out, key + ".json"), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    print("%d parkings dans %d fichiers" % (total, len(cells)))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
