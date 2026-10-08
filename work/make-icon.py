# Renders the Sigma app icon (rounded tile + geometric Σ) to the Tauri icon PNG. Same geometry as apps/web/public/favicon.svg.
import struct, zlib
from pathlib import Path

size,ss=256,3
scale=size/32
tile,ink=(227,138,98),(42,24,16)
points=[(22,9.5),(10.5,9.5),(16.75,16),(10.5,22.5),(22,22.5)]
half=1.3
def seg_dist(px,py,a,b):
    (ax,ay),(bx,by)=a,b;dx,dy=bx-ax,by-ay
    t=max(0,min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)))
    return ((px-ax-t*dx)**2+(py-ay-t*dy)**2)**.5
def in_tile(x,y,r=8):
    cx=min(max(x,r),32-r);cy=min(max(y,r),32-r)
    return (x-cx)**2+(y-cy)**2<=r*r
rows=[]
for y in range(size):
    row=bytearray([0])
    for x in range(size):
        cover=glyph=0
        for sy in range(ss):
            for sx in range(ss):
                u=(x+(sx+.5)/ss)/scale;v=(y+(sy+.5)/ss)/scale
                if in_tile(u,v):
                    cover+=1
                    if min(seg_dist(u,v,points[i],points[i+1]) for i in range(4))<=half:glyph+=1
        n=ss*ss
        if not cover:row.extend((0,0,0,0));continue
        g=glyph/cover
        row.extend([round(tile[i]*(1-g)+ink[i]*g) for i in range(3)]+[round(255*cover/n)])
    rows.append(bytes(row))
def chunk(kind,data):
    return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b'')
path=Path('apps/desktop/src-tauri/icons/icon.png')
path.parent.mkdir(parents=True,exist_ok=True)
path.write_bytes(png)
