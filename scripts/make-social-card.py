# Социальная карточка репозитория: 1280x640, как требует GitHub.
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
BG = (13, 17, 23)          # фон гитхаба в тёмной теме
INK = (230, 237, 243)
DIM = (125, 133, 144)
ACC = (88, 166, 255)       # синий гитхаба
GOOD = (63, 185, 80)
WARN = (210, 153, 34)
BAD = (248, 81, 73)

def font(name, size):
    return ImageFont.truetype(f"/System/Library/Fonts/{name}", size)

bold = lambda s: ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", s, index=1)
reg = lambda s: ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", s, index=0)
mono = lambda s: ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", s, index=0)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# Матрица закладок в реальных пропорциях разбора: 14% сигнал, 25% с примесью,
# 28% крючок, 33% шум. Отсортирована слева направо — видно перекос без подписи.
cols, rows = 30, 12
cell, gap = 14, 5
ox, oy = 74, 300
total = cols * rows
counts = [round(total * p) for p in (0.14, 0.25, 0.28, 0.33)]
counts[-1] += total - sum(counts)
order = ([GOOD] * counts[0] + [(139, 148, 158)] * counts[1]
         + [WARN] * counts[2] + [BAD] * counts[3])
for i, color in enumerate(order):
    c, r = i // rows, i % rows          # заполняем по столбцам: градиент слева направо
    x, y = ox + c * (cell + gap), oy + r * (cell + gap)
    d.rounded_rectangle([x, y, x + cell, y + cell], radius=3, fill=color)

# Заголовок
d.text((74, 96), "Hermes", font=bold(78), fill=INK)
d.text((74, 192), "2,080 saved posts, read aloud and graded", font=reg(31), fill=DIM)

# Подпись под матрицей
d.text((74, 262), "one square = one bookmark   ·   green: signal   ·   red: promise, no method",
       font=reg(18), fill=(110, 118, 129))

# Правая колонка: что делает
bx = 730
d.rounded_rectangle([bx, 96, W - 74, 254], radius=14, fill=(22, 27, 34), outline=(48, 54, 61))
d.text((bx + 28, 122), "you:", font=mono(20), fill=DIM)
d.text((bx + 78, 122), "go", font=mono(20), fill=ACC)
d.text((bx + 28, 158), "bot:  40s voice breakdown", font=mono(20), fill=INK)
d.text((bx + 28, 194), "      + 3-question test", font=mono(20), fill=INK)

lines = [
    ("Cloudflare Worker · Telegram · TTS", DIM),
    ("Pass 2 of 3 to close a bookmark.", INK),
    ("Listening isn't learning.", INK),
]
y = 300
for text, color in lines:
    d.text((bx, y), text, font=reg(24), fill=color)
    y += 46

d.text((bx, 470), "github.com/exyfi/tweetvaultagent", font=mono(21), fill=ACC)
d.line([bx, 520, W - 74, 520], fill=(48, 54, 61), width=1)
d.text((bx, 542), "MIT · self-hosted · no API keys for scraping", font=reg(18), fill=(110, 118, 129))

img.save("/Users/qmaroon/hermes-bookmarks/docs/social-card.png")
print("готово: 1280x640")
