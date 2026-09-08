#!/usr/bin/env python3
"""Folds an Expo web export into a document the API can serve from its own origin.

The entry bundle, the CSS reset and every referenced image are inlined into one
HTML file, so the first paint is a single response with no second origin and no
static file server.
"""
import base64, glob, os, re, shutil, sys

dist, out_path = sys.argv[1], sys.argv[2]
CHUNK_DIR = '_expo/static/js/web'
entries = glob.glob(os.path.join(dist, CHUNK_DIR, 'entry-*.js'))
if len(entries) != 1:
    raise SystemExit(
        f'expected exactly one entry bundle, found {len(entries)}. '
        'The document inlines the entry; more than one has no defined meaning.')

js = open(entries[0], encoding='utf-8').read()

MIME = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif': 'image/gif', 'svg': 'image/svg+xml'}
for ref in sorted(set(re.findall(
        r'assets/node_modules/[A-Za-z0-9/._-]+\.(?:png|jpg|jpeg|gif|svg)', js))):
    path = os.path.join(dist, ref)
    if not os.path.exists(path):
        continue
    ext = ref.rsplit('.', 1)[1].lower()
    data = base64.b64encode(open(path, 'rb').read()).decode()
    js = js.replace(ref, f'data:{MIME[ext]};base64,{data}')

js = js.replace('</script', '<\\/script')

html = open(os.path.join(dist, 'index.html'), encoding='utf-8').read()
css = re.search(r'<style id="expo-reset">(.*?)</style>', html, re.S).group(1)

ICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    '<rect width="32" height="32" rx="8" fill="#0E7A6E"/>'
    '<g transform="rotate(-45 16 16)">'
    '<rect x="7" y="12" width="18" height="8" rx="4" fill="#fff"/>'
    '<path d="M16 12h9a4 4 0 0 1 0 8h-9z" fill="#9BE3D8"/>'
    '</g></svg>'
)
ICON_URI = 'data:image/svg+xml;base64,' + base64.b64encode(ICON.encode()).decode()

os.makedirs(os.path.dirname(out_path), exist_ok=True)
open(out_path, 'w', encoding='utf-8').write(
    '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n'
    '<meta charset="utf-8" />\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover" />\n'
    '<meta name="theme-color" content="#0E7A6E" />\n'
    '<meta name="color-scheme" content="light" />\n'
    '<meta name="format-detection" content="telephone=no" />\n'
    '<meta name="mobile-web-app-capable" content="yes" />\n'
    '<meta name="apple-mobile-web-app-capable" content="yes" />\n'
    '<meta name="apple-mobile-web-app-status-bar-style" content="default" />\n'
    '<meta name="apple-mobile-web-app-title" content="دوائي" />\n'
    f'<link rel="icon" href="{ICON_URI}" />\n'
    f'<link rel="apple-touch-icon" href="{ICON_URI}" />\n'
    '<title>دوائي Dawaee</title>\n'
    f'<style id="expo-reset">{css}\n'
    'html,body,#root{min-height:100%;background:#F2F6F5}\n'
    'body{margin:0;overscroll-behavior-y:none;-webkit-tap-highlight-color:transparent}\n'
    'button,a,[role="button"]{touch-action:manipulation}\n'
    '</style>\n'
    '</head>\n<body>\n<div id="root"></div>\n'
    f'<script>\n{js}\n</script>\n</body>\n</html>\n')
print(f'{os.path.getsize(out_path)} bytes')

chunk_out = os.path.join(os.path.dirname(out_path), CHUNK_DIR)
shutil.rmtree(chunk_out, ignore_errors=True)
os.makedirs(chunk_out, exist_ok=True)
copied = 0
for path in sorted(glob.glob(os.path.join(dist, CHUNK_DIR, '*.js'))):
    if path == entries[0]:
        continue
    shutil.copyfile(path, os.path.join(chunk_out, os.path.basename(path)))
    copied += 1
print(f'{copied} lazily-loaded chunk(s) copied')
