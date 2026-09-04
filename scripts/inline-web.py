#!/usr/bin/env python3
"""Folds an Expo web export into a document the API can serve from its own origin.

The entry bundle, the CSS reset and every referenced image are inlined into one
HTML file, so the first paint is a single response with no second origin and no
static file server.

Metro also emits lazily-imported chunks. On this platform none of them is
reachable — the two dynamic imports in the app both sit behind a check that is
false on web — but "unreachable today" is not something a build should stake a
blank screen on, so the chunks are copied out beside the document and served
under the exact paths Metro asks for. Nothing has to stay true for the app to
keep working.
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

# Inlined rather than served from a path: without it the browser asks for
# /favicon.ico on every load and gets the API's JSON 404, which is a puzzling
# thing to find in the console of a healthy page.
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
    '<meta name="viewport" content="width=device-width, initial-scale=1, '
    'viewport-fit=cover" />\n'
    '<meta name="theme-color" content="#0E7A6E" />\n'
    f'<link rel="icon" href="{ICON_URI}" />\n'
    '<title>دوائي Dawaee</title>\n'
    f'<style id="expo-reset">{css}\nbody{{margin:0}}</style>\n'
    '</head>\n<body>\n<div id="root"></div>\n'
    f'<script>\n{js}\n</script>\n</body>\n</html>\n')
print(f'{os.path.getsize(out_path)} bytes')

# The lazily-imported chunks, at the paths Metro's loader will ask for. The
# directory is rebuilt each time so a chunk from an older build cannot linger
# and be served against a newer document.
chunk_out = os.path.join(os.path.dirname(out_path), CHUNK_DIR)
shutil.rmtree(chunk_out, ignore_errors=True)
os.makedirs(chunk_out, exist_ok=True)
copied = 0
for path in sorted(glob.glob(os.path.join(dist, CHUNK_DIR, '*.js'))):
    if path == entries[0]:
        continue  # inlined above
    shutil.copyfile(path, os.path.join(chunk_out, os.path.basename(path)))
    copied += 1
print(f'{copied} lazily-loaded chunk(s) copied')
