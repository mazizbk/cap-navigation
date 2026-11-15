"""Génère les icônes de l'application (PNG) sans aucune dépendance.
Usage : python tools/make_icons.py
"""
import os
import sys
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# Flèche de navigation, en coordonnées 0..1
ARROW = [(0.50, 0.17), (0.76, 0.80), (0.50, 0.66), (0.24, 0.80)]


def inside(x, y, poly):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def make(size):
    rows = []
    ss = 3  # sur-échantillonnage pour lisser les bords
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            cover = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    cover += inside(x, y, ARROW)
            a = cover / (ss * ss)
            t = (px + py) / (2 * size)  # dégradé en diagonale
            bg = (int(14 + 6 * t), int(20 + 60 * t), int(32 + 50 * t))
            fg = (255, 255, 255)
            row += bytes(int(bg[i] * (1 - a) + fg[i] * a) for i in range(3))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    # Tailles par défaut : icônes de la web app. Exemple pour l'application native : python make_icons.py 1024
    for s in ([int(a) for a in sys.argv[1:]] or [180, 512]):
        with open(os.path.join(OUT, f"icon-{s}.png"), "wb") as f:
            f.write(make(s))
        print("icons/icon-%d.png" % s)
