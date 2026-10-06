# usage: python3 split_files.py index.html   (run AFTER all patches; makes index.html.presplit first)
# Splits the single big file into: index.html (slim shell) + style.css + app.js + seed.js (loaded only when you press an import button)
import sys, shutil, json, re
f = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
src = open(f, encoding='utf-8').read()
shutil.copy(f, f + '.presplit')

# 1) CSS
a = src.index('<style>'); b = src.index('</style>')
css = src[a+len('<style>'):b].strip('\n')

# 2) main inline script (the only <script> tag without attributes)
sa = src.index('<script>'); sb = src.index('</script>', sa)
js = src[sa+len('<script>'):sb].strip('\n')

# 3) pull the two seed arrays out of app.js into seed.js, remember their sizes
seed_lines, keep, counts = [], [], {}
for line in js.split('\n'):
    m = re.match(r'^\s*const (SEED_\w+) = (\[.*\]);\s*$', line)
    if m:
        counts[m.group(1)] = len(json.loads(m.group(2)))
        seed_lines.append('const ' + m.group(1) + ' = ' + m.group(2) + ';')
    else:
        keep.append(line)
assert set(counts) == {'SEED_TAQSEET_2024', 'SEED_OLD_DEBTS_PRE2023'}, 'seed arrays not found: %s' % list(counts)
js = '\n'.join(keep)
for name, c in counts.items():                      # settings text / toasts only need the numbers
    js = js.replace('${%s.length}' % name, str(c))
assert 'SEED_TAQSEET_2024.length' not in js and 'SEED_OLD_DEBTS_PRE2023.length' not in js

# 4) lazy-load seed.js inside the two import functions
LOADER = '''let _seedP = null;
  function loadSeed(){
    if(typeof SEED_TAQSEET_2024 !== 'undefined') return Promise.resolve();
    return _seedP = _seedP || new Promise((res, rej)=>{
      const s = document.createElement('script'); s.src = 'seed.js'; s.onload = res;
      s.onerror = ()=>{ _seedP = null; showToast('تعذّر تحميل ملف البيانات seed.js'); rej(); };
      document.head.appendChild(s);
    });
  }
  '''
for fn, flag in (('importTaqseet2024', 'importedTaqseet2024'), ('importOldDebtsPre2023', 'importedOldDebtsPre2023')):
    old = 'function %s(){' % fn
    assert js.count(old) == 1, 'import function not found: ' + fn
    new = ('async function %s(){ if(state.settings.%s) return; try{ await loadSeed(); }catch(e){ return; }' % (fn, flag))
    if fn == 'importTaqseet2024': new = LOADER + new
    js = js.replace(old, new)

# 5) write the files + slim index.html
open('style.css', 'w', encoding='utf-8').write(css + '\n')
open('app.js', 'w', encoding='utf-8').write(js + '\n')
open('seed.js', 'w', encoding='utf-8').write('\n'.join(seed_lines) + '\n')
shell = src[:a] .rstrip() + '\n<link rel="stylesheet" href="style.css">' + src[b+len('</style>'):sa] + '<script src="app.js"></script>' + src[sb+len('</script>'):]
open(f, 'w', encoding='utf-8').write(shell)
print('OK  index.html: %d KB | style.css: %d KB | app.js: %d KB | seed.js (lazy): %d KB' % tuple(
    len(open(p, encoding='utf-8').read().encode()) // 1024 for p in (f, 'style.css', 'app.js', 'seed.js')))
