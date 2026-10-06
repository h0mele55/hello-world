"""Build a demo copy of the workbook and render one screenshot per sheet area."""
import os, shutil, subprocess, sys
from datetime import date
from openpyxl import load_workbook

SRC, OUT = sys.argv[1], sys.argv[2]
RECALC = sys.argv[3]
os.makedirs(OUT, exist_ok=True)
demo = os.path.join(OUT, 'demo.xlsx')
shutil.copy(SRC, demo)

wb = load_workbook(demo)
p, ph, wl, ag = wb['Projects'], wb['Phasing'], wb['WIP Log'], wb['Aggregator']


def add(r, name, em, start, dur, contract, weights=None, wip=None):
    p.cell(r, 2, name); p.cell(r, 3, em); p.cell(r, 4, start); p.cell(r, 5, dur); p.cell(r, 7, contract)
    for i, w in enumerate(weights or []):
        ph.cell(r, 9 + i, w)
    for col, v in (wip or {}).items():   # col = 0-based timeline index (0 = Jan 2026)
        wl.cell(r, 4 + col, v)


add(7, 'Data Platform Migration', 'M. Laurent', date(2026, 6, 1), 12, 120000, None, {5: 9000, 6: 9000, 7: 9000, 8: 9000, 9: 9000})
add(8, 'CRM Rollout', 'A. Okafor', date(2026, 1, 1), 9, 45000, [1, 1, 2, 2, 2, 1, 1, 1, 1], {i: 5000 for i in range(9)})
add(9, 'Security Audit', 'S. Novak', date(2027, 3, 1), 4, 30000, [1, 2, 2, 1])
add(10, 'Cloud Cost Review', 'R. Patel', date(2026, 8, 1), 6, 18000, [2, 2, 1, 1, 1, 1], {7: 4000, 8: 4000, 9: 3000})
add(11, 'Analytics Pilot', 'L. Chen', date(2026, 9, 1), 3, 9000, None, {8: 6000, 9: 4500})
for j in range(24):
    ag.cell(6 + j, 6, 25000)
wb.save(demo)
print(subprocess.run([sys.executable, RECALC, demo, '120'], capture_output=True, text=True).stdout[:120])

SHOTS = {
    'readme': ('README', 'B1:C38'),
    'projects': ('Projects', 'A1:N13'),
    'phasing': ('Phasing', 'A1:R13'),
    'wiplog': ('WIP Log', 'A1:T13'),
    'projectpage': ('Project Page', 'A1:I30'),
    'projectchart': ('Project Page', 'K3:X22'),
    'timeline': ('Timeline', 'A1:AD13'),
    'aggregator': ('Aggregator', 'A1:G32'),
    'aggannual': ('Aggregator', 'I5:X37'),
    'phased': ('Phased Budget', 'A1:Z13'),
}
for key, (sheet, area) in SHOTS.items():
    wb = load_workbook(demo)
    for ws in wb.worksheets:
        ws.sheet_state = 'visible' if ws.title == sheet else 'hidden'
    ws = wb[sheet]
    wb.active = wb.worksheets.index(ws)
    ws.print_area = area
    ws.print_title_rows = None
    ws.page_setup.orientation = 'landscape'
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_options.gridLines = False
    ws.page_margins.left = ws.page_margins.right = ws.page_margins.top = ws.page_margins.bottom = 0.2
    ws.oddHeader.center.text = ws.oddFooter.center.text = ''
    x = os.path.join(OUT, f'{key}.xlsx')
    wb.save(x)
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', OUT, x], capture_output=True)
    subprocess.run(['pdftoppm', '-png', '-r', '170', '-f', '1', '-l', '1', '-singlefile',
                    os.path.join(OUT, f'{key}.pdf'), os.path.join(OUT, key)], capture_output=True)
    # trim whitespace
    from PIL import Image, ImageChops
    im = Image.open(os.path.join(OUT, f'{key}.png')).convert('RGB')
    bg = Image.new('RGB', im.size, (255, 255, 255))
    bbox = ImageChops.difference(im, bg).getbbox()
    if bbox:
        im = im.crop((max(0, bbox[0] - 8), max(0, bbox[1] - 8), min(im.width, bbox[2] + 8), min(im.height, bbox[3] + 8)))
    im.save(os.path.join(OUT, f'{key}.png'))
    print(key, im.size)
