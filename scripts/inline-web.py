#!/usr/bin/env python3
"""Folds an Expo web export into a document the API can serve from its own origin.

The entry bundle, the CSS reset and every referenced image are inlined into one
HTML file, so the first paint is a single response with no second origin and no
static file server.

Expo's web Linking implementation currently treats every window ``message`` as
a URL event without authenticating the sender, and the SDK version pinned by
this repository also double-encodes/decodes query values around URLSearchParams.
Both behaviors cross a security boundary in a browser.  The production build
hardens those dependency shapes here, at the deterministic bundling
boundary.  The replacements are intentionally fail-closed: an Expo upgrade that
changes any expected structure stops the build instead of silently dropping the
hardening.
"""
import base64, glob, hashlib, os, re, shutil, sys

dist, out_path = sys.argv[1], sys.argv[2]
CHUNK_DIR = '_expo/static/js/web'
entries = glob.glob(os.path.join(dist, CHUNK_DIR, 'entry-*.js'))
if len(entries) != 1:
    raise SystemExit(
        f'expected exactly one entry bundle, found {len(entries)}. '
        'The document inlines the entry; more than one has no defined meaning.')

js = open(entries[0], encoding='utf-8').read()

# Minified local names and string quotes vary with the entry graph. Bind
# repeated identifiers to the same capture instead of trusting fixed names.
# Everything else in the four known SDK shapes remains mandatory, including
# exactly one occurrence per shape. This is not a general JS sanitizer.
IDENTIFIER = r'[A-Za-z_$][A-Za-z0-9_$]*'

def replace_structure(source, pattern, replacement, label):
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise SystemExit(
            f'web hardening drift: expected 1 {label} snippet(s), found {len(matches)}')
    match = matches[0]
    return source[:match.start()] + replacement(match) + source[match.end():]

handler = (
    rf'const (?P<handler>{IDENTIFIER})=(?P<event>{IDENTIFIER})=>'
    rf'(?P<listener>{IDENTIFIER})\(\{{url:window\.location\.href,nativeEvent:(?P=event)\}}\);return '
)
registration = (
    r"window\.addEventListener\((?P<quote>['\"])message(?P=quote),(?P=handler),!1\)"
)

def guard_handler(match):
    event = match['event']
    return (
        f"const {match['handler']}={event}=>{{"
        f'if({event}.origin!==window.location.origin)return;'
        f"{match['listener']}({{url:window.location.href,nativeEvent:{event}}})"
        '};return ' + match['registration']
    )

# Both Expo web Linking callbacks only re-read this window's URL. Reject
# cross-origin signals while preserving same-origin callbacks and removers.
js = replace_structure(
    js, handler + rf'(?P<registration>{registration})', guard_handler,
    'ExpoLinking.addListener message handler',
)
js = replace_structure(
    js, handler + (
        rf'(?P<registration>{IDENTIFIER}\.push\(\{{listener:(?P=listener),'
        rf'nativeListener:(?P=handler)\}}\),{registration})'
    ), guard_handler, 'RNLinking.addEventListener message handler',
)

# URLSearchParams already encodes on set and decodes on iteration. Preserve
# literal percent sequences by removing only the redundant wrappers.
js = replace_structure(
    js,
    rf'(?<![A-Za-z0-9_$.])(?P<url>{IDENTIFIER})\.searchParams\.set\('
    rf'(?P<key>{IDENTIFIER}),encodeURIComponent\((?P<value>{IDENTIFIER})\)\)',
    lambda match: f"{match['url']}.searchParams.set({match['key']},{match['value']})",
    'Expo Linking query encoding',
)
js = replace_structure(
    js,
    rf'(?<![A-Za-z0-9_$.])(?P<target>{IDENTIFIER})\[(?P<key>{IDENTIFIER})\]='
    rf'decodeURIComponent\((?P<value>{IDENTIFIER})\)',
    lambda match: f"{match['target']}[{match['key']}]={match['value']}",
    'Expo Linking query decoding',
)

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
script_body = '\n' + js + '\n'
script_sha256 = base64.b64encode(
    hashlib.sha256(script_body.encode('utf-8')).digest()).decode('ascii')

html = open(os.path.join(dist, 'index.html'), encoding='utf-8').read()
css_match = re.search(r'<style id="expo-reset">(.*?)</style>', html, re.S)
if css_match is None:
    raise SystemExit('expected Expo reset style in index.html')
css = css_match.group(1)

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
# Publish the sidecar first. On a clean checkout (the CI/production case), the
# server cannot observe the document until its matching CSP metadata exists.
open(out_path + '.script-sha256', 'w', encoding='ascii').write(script_sha256 + '\n')
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
    f'<script>{script_body}</script>\n</body>\n</html>\n')
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
