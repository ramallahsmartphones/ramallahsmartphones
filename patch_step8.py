# usage: python3 patch_step8.py index.html   (run AFTER patch_step7.py; makes index.html.bak8 first)
import sys, shutil
f = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
src = open(f, encoding='utf-8').read()
shutil.copy(f, f + '.bak8')
old = "window.AppAPI = { isCashReceipt,"
new = "window.AppAPI = { pgSlice, pgReset: ()=>{ Object.keys(pgLimits).forEach(k=>delete pgLimits[k]); }, isCashReceipt,"
assert src.count(old) == 1, 'anchor not unique/found'
open(f, 'w', encoding='utf-8').write(src.replace(old, new))
print('OK: 1 edit applied')
