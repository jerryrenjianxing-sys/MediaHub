from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parent.parent
image = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 248, 248), radius=58, fill='#193c36')
draw.rounded_rectangle((46, 46, 210, 210), radius=38, outline='#88d9bc', width=9)
draw.line([(73, 165), (73, 90), (110, 135), (147, 90), (147, 165)], fill='#eff7f3', width=13, joint='curve')
draw.line([(181, 90), (181, 165)], fill='#88d9bc', width=13)
draw.line([(147, 128), (181, 128)], fill='#88d9bc', width=13)
image.save(root / 'resources/mediahub.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
