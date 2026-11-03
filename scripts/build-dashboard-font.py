"""Build the offline UI font subset from a licensed Noto Sans SC variable TTF.

Usage: python scripts/build-dashboard-font.py <NotoSansSC-VF.ttf>
Requires fontTools (build-time only); no network or runtime package dependency.
"""
from pathlib import Path
import hashlib
import json
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[1]
web = root / 'apps' / 'team-space-web'
source = Path(sys.argv[1])
font = TTFont(source, recalcTimestamp=False)
characters = set(chr(i) for i in range(32, 127))
for path in sorted(web.glob('dispatch*')):
    if path.suffix in {'.js', '.mjs', '.html', '.css'}:
        characters.update(path.read_text(encoding='utf-8-sig'))
options = subset.Options()
options.flavor = 'woff'
options.name_IDs = ['*']
options.name_languages = ['*']
options.name_legacy = True
worker = subset.Subsetter(options=options)
worker.populate(text=''.join(sorted(characters)))
worker.subset(font)
font.flavor = 'woff'
destination = web / 'fonts'
destination.mkdir(exist_ok=True)
font.save(destination / 'harmony-ui.woff')
metadata = {
    'family': 'Noto Sans SC', 'cssAlias': 'Harmony UI',
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'fontVersion': font['name'].getDebugName(5),
    'license': 'SIL Open Font License 1.1; see OFL.txt',
    'modification': 'WOFF subset of dashboard source characters plus printable ASCII; weight axis preserved.',
    'characterCount': len(font.getBestCmap()),
    'fallback': 'Dynamic names with other glyphs use installed Noto Sans SC, Segoe UI or Microsoft YaHei.'
}
(destination / 'font-source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f"Built {destination.name}/harmony-ui.woff: {(destination / 'harmony-ui.woff').stat().st_size} bytes, {metadata['characterCount']} characters")
