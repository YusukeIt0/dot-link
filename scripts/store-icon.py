"""Reproduce the code-native monochrome store icon without external packages."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'assets' / 'store'
OUT.mkdir(parents=True, exist_ok=True)
SIZE = 512

def png(name, rgba):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = b''.join(b'\0' + rgba[y * SIZE * 4:(y + 1) * SIZE * 4] for y in range(SIZE))
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')
    (OUT / name).write_bytes(data)
    print(f'{name}: {SIZE}x{SIZE}, {len(data)} bytes')

foreground = bytearray()
background = bytearray()
preview = bytearray()
for y in range(SIZE):
    for x in range(SIZE):
        coverage = sum((x + (sx + 0.5) / 4 - 256) ** 2 + (y + (sy + 0.5) / 4 - 256) ** 2 <= 112 ** 2
                       for sx in range(4) for sy in range(4))
        alpha = round(255 * coverage / 16)
        grey = round(17 + 238 * alpha / 255)
        foreground.extend((255, 255, 255, alpha))
        background.extend((17, 17, 17, 255))
        preview.extend((grey, grey, grey, 255))
png('icon-foreground.png', foreground)
png('icon-background.png', background)
png('icon-preview.png', preview)
(OUT / 'icon-foreground.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>Dot Link</title><circle cx="256" cy="256" r="112" fill="#fff"/></svg>\n')
(OUT / 'icon-background.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#111"/></svg>\n')
