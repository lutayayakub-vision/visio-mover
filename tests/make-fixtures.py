"""Generates test media with KNOWN pixel values so exported files can be verified independently (PIL / ffprobe)."""
import os, random, subprocess, sys
from PIL import Image, ImageDraw
out = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(out, exist_ok=True)

# quad.png: 400x300, quadrants TL red, TR green, BL blue, BR yellow
q = Image.new("RGB", (400, 300))
d = ImageDraw.Draw(q)
d.rectangle([0, 0, 199, 149], (255, 0, 0)); d.rectangle([200, 0, 399, 149], (0, 255, 0))
d.rectangle([0, 150, 199, 299], (0, 0, 255)); d.rectangle([200, 150, 399, 299], (255, 255, 0))
q.save(f"{out}/quad.png")
q.save(f"{out}/quad.jpg", quality=95)
q.save(f"{out}/quad.webp", quality=95)

# gray.png: flat mid-gray (100,100,100) for brightness/contrast maths
Image.new("RGB", (100, 100), (100, 100, 100)).save(f"{out}/gray.png")

# alpha.png: fully transparent -> must become white when exported as JPG
Image.new("RGBA", (120, 80), (255, 0, 0, 0)).save(f"{out}/alpha.png")

# photo.jpg: 1200x800 noisy gradient (compression-sensitive)
random.seed(1)
p = Image.new("RGB", (1200, 800))
px = p.load()
for y in range(800):
    for x in range(1200):
        px[x, y] = ((x * 255 // 1200 + random.randint(-25, 25)) % 256, (y * 255 // 800 + random.randint(-25, 25)) % 256, ((x + y) * 255 // 2000 + random.randint(-25, 25)) % 256)
p.save(f"{out}/photo.jpg", quality=95)

# oriented.jpg: stored 300x200 landscape pixels with EXIF Orientation=6 (displays as 200x300 portrait)
o = Image.new("RGB", (300, 200), (0, 0, 255)); ImageDraw.Draw(o).rectangle([0, 0, 149, 99], (255, 0, 0))
ex = Image.Exif(); ex[0x0112] = 6
o.save(f"{out}/oriented.jpg", quality=95, exif=ex)

# big.jpg: 6000x4000 = 24 MP (large-image test)
big = Image.linear_gradient("L").resize((6000, 4000))
Image.merge("RGB", (big, big.transpose(Image.FLIP_TOP_BOTTOM), Image.new("L", (6000, 4000), 90))).save(f"{out}/big.jpg", quality=85)

# huge.jpg header only is enough? make a real 12000x9000 (108 MP) solid image: compresses to a few KB
Image.new("RGB", (12000, 9000), (10, 20, 30)).save(f"{out}/huge.jpg", quality=50)

# not_an_image.png: text pretending to be PNG
open(f"{out}/fake.png", "w").write("this is not a png")

# video: 6 s 640x360 30fps with a visible counter + 440 Hz tone, H.264/AAC (also an audio-less variant)
src = f"{out}/clip.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", src], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=4",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", f"{out}/silent.mp4"], check=True)
print("fixtures ok:", sorted(os.listdir(out)))

# clip720.mp4: 4 s 1280x720 with audio (downscale tests); fake.mp4: text pretending to be video
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4",
                "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", f"{out}/clip720.mp4"], check=True)
open(f"{out}/fake.mp4", "w").write("this is not a video file at all")
print("video fixtures ok")

# cleanup.png/.jpg/.webp: 800x600 diagonal stripes + noise with ONE solid red disc (centre 400,300 r 45) = the "unwanted object"
random.seed(7)
c = Image.new("RGB", (800, 600))
cp = c.load()
for y in range(600):
    for x in range(800):
        s = 150 + (40 if ((x + y) // 24) % 2 else -40)
        cp[x, y] = (max(0, min(255, s + random.randint(-8, 8))), max(0, min(255, s - 20 + random.randint(-8, 8))), max(0, min(255, s + 30 + random.randint(-8, 8))))
ImageDraw.Draw(c).ellipse([400 - 45, 300 - 45, 400 + 45, 300 + 45], fill=(255, 0, 0))
c.save(f"{out}/cleanup.png")
c.save(f"{out}/cleanup.jpg", quality=95)
c.save(f"{out}/cleanup.webp", quality=95)
