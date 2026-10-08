(function(){
  "use strict";

  const STORAGE_KEY = "ledger-data";

  let state = { customers: [], purchases: [], payments: [], history: [], accounts:[], supplierTx:[], inventory:[], cheques:[], settings: { overdueDays: 45, currency: "₪", showCurrency: true, wrapCells: false } };
  let ready = false;
  let currentTab = "customers";
  let search = { customers:"" };
  let statFilter = "all";
  let sortDesc = true;
  let reportsSubTab = "statistics";
  let saveStatus = 'ok'; // 'ok' | 'error'

  // ---------- Firebase (real account + live sync across devices) ----------
  const firebaseConfig = {
    apiKey: "AIzaSyDMP_YZPO6U0kPfm0J945GebFpi7QRsjFw",
    authDomain: "ramallahsmartphones-b665d.firebaseapp.com",
    projectId: "ramallahsmartphones-b665d",
    storageBucket: "ramallahsmartphones-b665d.firebasestorage.app",
    messagingSenderId: "293481377053",
    appId: "1:293481377053:web:55dbf210d9bf5f86c6c5f4"
  };
  firebase.initializeApp(firebaseConfig);
  const fbAuth = firebase.auth();
  const db = firebase.firestore();
  try{ db.enablePersistence({ synchronizeTabs: true }).catch(()=>{}); }catch(e){}

  let firestoreUnsub = null;
  // آخر نسخة معروفة من كل عنصر كما هي على السيرفر (id -> data)، تُحدَّث من onSnapshot
  // وتُستخدم في saveData() لمعرفة أي عنصر يحتاج إنشاء/تحديث/حذف فعلياً بدل إعادة كتابة كل شيء.
  const COLS = ['customers','purchases','payments','history','accounts','supplierTx','inventory','cheques'];
  let synced = {}; COLS.forEach(c=>synced[c]={});

  // ---------- TOTP authenticator (Google Authenticator / Microsoft Authenticator / Authy compatible) ----------
  const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32Encode(bytes){
    let bits = "", out = "";
    for(const b of bytes) bits += b.toString(2).padStart(8,"0");
    for(let i=0;i+5<=bits.length;i+=5) out += BASE32_ALPHABET[parseInt(bits.substr(i,5),2)];
    const rem = bits.length % 5;
    if(rem) out += BASE32_ALPHABET[parseInt(bits.substr(bits.length-rem).padEnd(5,"0"),2)];
    return out;
  }
  function base32Decode(str){
    str = str.toUpperCase().replace(/[^A-Z2-7]/g,"");
    let bits = "";
    for(const c of str) bits += BASE32_ALPHABET.indexOf(c).toString(2).padStart(5,"0");
    const bytes = [];
    for(let i=0;i+8<=bits.length;i+=8) bytes.push(parseInt(bits.substr(i,8),2));
    return new Uint8Array(bytes);
  }
  function generateTotpSecret(){
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return base32Encode(bytes);
  }
  async function totpCodeAt(secretBase32, atMs, step, digits){
    step = step || 30; digits = digits || 6;
    const key = base32Decode(secretBase32);
    const counter = Math.floor(Math.floor(atMs/1000)/step);
    const counterBuf = new ArrayBuffer(8);
    new DataView(counterBuf).setUint32(4, counter, false);
    const cryptoKey = await crypto.subtle.importKey("raw", key, {name:"HMAC", hash:"SHA-1"}, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBuf));
    const offset = sig[sig.length-1] & 0xf;
    const binCode = ((sig[offset]&0x7f)<<24) | ((sig[offset+1]&0xff)<<16) | ((sig[offset+2]&0xff)<<8) | (sig[offset+3]&0xff);
    const otp = binCode % Math.pow(10, digits);
    return String(otp).padStart(digits, "0");
  }
  async function verifyTotp(secretBase32, code){
    code = String(code).trim();
    const now = Date.now();
    for(let w=-1; w<=1; w++){
      const candidate = await totpCodeAt(secretBase32, now + w*30000);
      if(candidate === code) return true;
    }
    return false;
  }

  function translateAuthError(code){
    const map = {
      'auth/email-already-in-use': 'هذا البريد مستخدم مسبقاً — جرّب تسجيل الدخول بدلاً من إنشاء حساب جديد',
      'auth/invalid-email': 'صيغة البريد الإلكتروني غير صحيحة',
      'auth/weak-password': 'كلمة المرور ضعيفة، استخدم ٦ أحرف على الأقل',
      'auth/user-not-found': 'لا يوجد حساب بهذا البريد',
      'auth/wrong-password': 'كلمة المرور غير صحيحة',
      'auth/invalid-credential': 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      'auth/network-request-failed': 'تعذر الاتصال بالإنترنت، تحقق من الاتصال وحاول مرة أخرى',
      'auth/too-many-requests': 'محاولات كثيرة جداً، حاول لاحقاً',
      'auth/missing-password': 'الرجاء إدخال كلمة المرور',
    };
    return map[code] || ('حدث خطأ: ' + code);
  }

  function renderAuthGate(mode){
    mode = mode || 'login';
    appEl.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="brand-mark" style="margin:0 auto 14px">أ</div>
          <h1 style="text-align:center;margin:0 0 4px">مكة للهواتف الذكية</h1>
          <p class="hint" style="text-align:center;margin-bottom:20px">${mode==='signup' ? 'أنشئ حساباً جديداً للبدء' : 'سجّل الدخول للمتابعة من أي جهاز'}</p>
          <div class="field" style="margin-bottom:12px"><label>البريد الإلكتروني</label><input type="email" id="auth_email" autocomplete="username"></div>
          <div class="field" style="margin-bottom:10px"><label>كلمة المرور</label><input type="password" id="auth_pass" autocomplete="${mode==='signup'?'new-password':'current-password'}"></div>
          <p id="authError" class="hint" style="color:var(--bad);min-height:16px;margin-bottom:10px"></p>
          <button class="btn btn-primary" id="auth_submit_btn" style="width:100%">${mode==='signup' ? 'إنشاء الحساب' : 'دخول'}</button>          <button class="btn btn-ghost" id="googleBtn" style="width:100%;margin-top:10px">الدخول بحساب Google</button>
          <p class="hint" style="text-align:center;margin-top:16px">
            ${mode==='signup' ? 'لديك حساب مسبقاً؟ ' : 'ليس لديك حساب؟ '}
            <a href="#" id="switchMode" style="color:var(--brass);font-weight:700;text-decoration:none">${mode==='signup' ? 'سجّل الدخول' : 'أنشئ حساباً جديداً'}</a>
          </p>
          ${mode==='login' ? '<p class="hint" style="text-align:center;margin-top:4px"><a href="#" id="forgotPass" style="color:var(--muted);text-decoration:underline">نسيت كلمة المرور؟</a></p>' : ''}
        </div>
      </div>
    `;
    document.getElementById("switchMode").addEventListener("click",(e)=>{ e.preventDefault(); renderAuthGate(mode==='signup'?'login':'signup'); });
    const submit = () => {
      const email = document.getElementById("auth_email").value.trim();
      const pass = document.getElementById("auth_pass").value;
      const errEl = document.getElementById("authError");
      errEl.textContent = "";
      if(!email || !pass){ errEl.textContent = "الرجاء تعبئة كل الحقول"; return; }
      const action = mode==='signup'
        ? fbAuth.createUserWithEmailAndPassword(email, pass)
        : fbAuth.signInWithEmailAndPassword(email, pass);
      action.catch(err => { errEl.textContent = translateAuthError(err.code); });
    };
    document.getElementById("auth_submit_btn").addEventListener("click", submit);    document.getElementById("googleBtn").addEventListener("click", ()=>{
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      fbAuth.signInWithPopup(provider).catch(err=>{
        if(err.code==='auth/popup-blocked' || err.code==='auth/operation-not-supported-in-this-environment'){ fbAuth.signInWithRedirect(provider); return; }
        if(err.code==='auth/popup-closed-by-user' || err.code==='auth/cancelled-popup-request') return;
        document.getElementById("authError").textContent = err.code==='auth/account-exists-with-different-credential'
          ? 'هذا البريد مسجّل بطريقة دخول أخرى، سجّل بها أولاً' : translateAuthError(err.code);
      });
    });
    document.getElementById("auth_pass").addEventListener("keydown",(e)=>{ if(e.key==="Enter") submit(); });
    const forgot = document.getElementById("forgotPass");
    if(forgot){
      forgot.addEventListener("click",(e)=>{
        e.preventDefault();
        const email = document.getElementById("auth_email").value.trim();
        if(!email){ document.getElementById("authError").textContent = "اكتب بريدك الإلكتروني أولاً ثم اضغط الرابط"; return; }
        fbAuth.sendPasswordResetEmail(email)
          .then(()=>showToast("تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك"))
          .catch(err=>{ document.getElementById("authError").textContent = translateAuthError(err.code); });
      });
    }
  }

  function attachFirestoreListener(uid){
    if(firestoreUnsub) firestoreUnsub();
    const base = db.collection('ledgers').doc(uid);
    const got = { settings:false }; COLS.forEach(c=>got[c]=false);
    let docExisted = false;

    function checkReady(){
      if(Object.values(got).every(Boolean)){
        if(!ready && !docExisted){
          // حساب جديد كلياً: لا مستند إعدادات ولا أي عنصر بأي مجموعة فرعية
          ready = true;
          offerLocalDataImportThenSave();
        } else {
          ready = true;
          saveStatus = 'ok';
          render();
        }
      }
    }
    function onErr(err){
      console.error(err);
      saveStatus = 'error';
      ready = true;
      render();
    }

    const unsubs = [];
    unsubs.push(base.onSnapshot((snap) => {
      if(snap.exists){
        docExisted = true;
        state.settings = Object.assign({overdueDays:45, currency:"₪", showCurrency:true, wrapCells:false}, (snap.data()||{}).settings || {});
      }
      got.settings = true; checkReady();
    }, onErr));

    COLS.forEach(name=>{
      unsubs.push(base.collection(name).onSnapshot((snap) => {
        if(snap.size > 0) docExisted = true;
        const map = {};
        const items = snap.docs.map(d=>{ map[d.id] = d.data(); return d.data(); });
        state[name] = items;
        synced[name] = map;
        got[name] = true; checkReady();
      }, onErr));
    });

    firestoreUnsub = () => unsubs.forEach(fn=>fn());
  }

  // ---------- ترحيل تلقائي لمرة واحدة: من المستند القديم (كل شيء بحقل واحد) إلى مجموعات فرعية ----------
  async function migrateOldDocIfNeeded(uid){
    const base = db.collection('ledgers').doc(uid);
    let snap;
    try{ snap = await base.get(); }catch(e){ console.error(e); return; } // بلا إنترنت: لا نحاول الترحيل الآن، سيُعاد المحاولة بجلسة لاحقة
    if(!snap.exists) return; // حساب جديد كلياً، لا يوجد شيء لترحيله
    const data = snap.data();
    const hasOldArrays = Array.isArray(data.customers) || Array.isArray(data.purchases) || Array.isArray(data.payments) || Array.isArray(data.history);
    if(!hasOldArrays) return; // تم الترحيل مسبقاً (أو حساب جديد بالتصميم الجديد أصلاً)

    async function copyArray(name, arr){
      const items = (arr || []).filter(x=>x && x.id);
      for(let i=0;i<items.length;i+=400){
        const batch = db.batch();
        items.slice(i,i+400).forEach(item=> batch.set(base.collection(name).doc(item.id), item));
        await batch.commit();
      }
    }
    try{
      await copyArray('customers', data.customers);
      await copyArray('purchases', data.purchases);
      await copyArray('payments', data.payments);
      await copyArray('history', data.history);
      // بعد التأكد من نجاح نسخ كل شيء للمجموعات الفرعية، نستبدل المستند الرئيسي
      // بالإعدادات فقط (set بدون merge لحذف الحقول القديمة الضخمة نهائياً)
      await base.set({ settings: data.settings || {} });
    }catch(e){
      console.error('migration failed, will retry next session', e);
      // لا نحذف أي شيء من المستند القديم إذا فشل الترحيل — البيانات القديمة تبقى سليمة كما هي
    }
  }

  function offerLocalDataImportThenSave(){
    // brand-new account: offer to import any data previously stored on this device/browser
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw){
        const parsed = JSON.parse(raw);
        const has = (parsed.customers&&parsed.customers.length) || (parsed.purchases&&parsed.purchases.length) || (parsed.payments&&parsed.payments.length);
        if(has && confirm('وجدنا بيانات محفوظة سابقاً على هذا الجهاز، هل تريد استيرادها لهذا الحساب الجديد؟')){
          state.customers = parsed.customers || [];
          state.purchases = parsed.purchases || [];
          state.payments = parsed.payments || [];
          state.settings = Object.assign({overdueDays:45, currency:"₪", showCurrency:true, wrapCells:false}, parsed.settings || {});
          state.history = parsed.history || [];
        }
      }
    }catch(e){ /* ignore */ }
    saveData();
    render();
  }

  // ---------- TOTP login gate (second step, only for accounts with Authenticator enabled) ----------
  let totpVerified = false;
  function renderTotpLoginGate(uid, secret){
    appEl.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="brand-mark" style="margin:0 auto 14px">أ</div>
          <h1 style="text-align:center;margin:0 0 4px">التحقق بخطوتين</h1>
          <p class="hint" style="text-align:center;margin-bottom:20px">أدخل الرمز المكوّن من ٦ أرقام من تطبيق المصادقة (Authenticator) على جهازك</p>
          <div class="field" style="margin-bottom:12px">
            <label>رمز التحقق</label>
            <input type="text" id="totpLoginCode" maxlength="6" inputmode="numeric" dir="ltr" style="text-align:center;letter-spacing:4px;font-size:20px">
          </div>
          <p id="totpLoginError" class="hint" style="color:var(--bad);min-height:16px;margin-bottom:10px"></p>
          <button class="btn btn-primary" id="totpLoginSubmit" style="width:100%">تأكيد</button>
          <p class="hint" style="text-align:center;margin-top:16px"><a href="#" id="totpCancel" style="color:var(--muted);text-decoration:underline">تسجيل الخروج</a></p>
        </div>
      </div>`;
    const submit = async () => {
      const code = document.getElementById("totpLoginCode").value.trim();
      const errEl = document.getElementById("totpLoginError");
      if(!/^\d{6}$/.test(code)){ errEl.textContent = "أدخل رمزاً من ٦ أرقام"; return; }
      const ok = await verifyTotp(secret, code);
      if(!ok){ errEl.textContent = "الرمز غير صحيح، تأكد من ضبط الوقت في جهازك"; return; }
      totpVerified = true;
      await migrateOldDocIfNeeded(uid);
      attachFirestoreListener(uid);
      startHardSessionTimer();
    };
    document.getElementById("totpLoginSubmit").addEventListener("click", submit);
    document.getElementById("totpLoginCode").addEventListener("keydown",(e)=>{ if(e.key==="Enter") submit(); });
    document.getElementById("totpCancel").addEventListener("click",(e)=>{ e.preventDefault(); fbAuth.signOut(); });
  }

  function renderTotpEnrollGate(uid, email){
    const secret = generateTotpSecret();
    appEl.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="brand-mark" style="margin:0 auto 14px">أ</div>
          <h1 style="text-align:center;margin:0 0 4px">تفعيل التحقق بخطوتين</h1>
          <p class="hint" style="text-align:center;margin-bottom:14px">الدخول بحساب Google يتطلب تطبيق المصادقة. افتح Google Authenticator واختر "إدخال المفتاح يدوياً" وأدخل المفتاح التالي:</p>
          <div class="field" style="margin-bottom:12px">
            <label>المفتاح السري</label>
            <input type="text" readonly value="${secret}" dir="ltr" style="font-family:monospace;letter-spacing:1px;text-align:center" onclick="this.select()">
          </div>
          <div class="field" style="margin-bottom:12px">
            <label>رمز التحقق (٦ أرقام)</label>
            <input type="text" id="totpEnrollCode" maxlength="6" inputmode="numeric" dir="ltr" style="text-align:center;letter-spacing:4px;font-size:20px">
          </div>
          <p id="totpEnrollError" class="hint" style="color:var(--bad);min-height:16px;margin-bottom:10px"></p>
          <button class="btn btn-primary" id="totpEnrollSubmit" style="width:100%">تفعيل ودخول</button>
          <p class="hint" style="text-align:center;margin-top:16px"><a href="#" id="totpEnrollCancel" style="color:var(--muted);text-decoration:underline">تسجيل الخروج</a></p>
        </div>
      </div>`;
    const submit = async () => {
      const code = document.getElementById("totpEnrollCode").value.trim();
      const errEl = document.getElementById("totpEnrollError");
      if(!/^\d{6}$/.test(code)){ errEl.textContent = "أدخل رمزاً من ٦ أرقام"; return; }
      if(!(await verifyTotp(secret, code))){ errEl.textContent = "الرمز غير صحيح، تأكد من ضبط الوقت في جهازك"; return; }
      try{
        await db.collection('ledgers').doc(uid).set({ settings: { totpEnabled: true, totpSecret: secret } }, { merge: true });
      }catch(e){ errEl.textContent = "تعذّر حفظ الإعداد، تحقق من الاتصال"; return; }
      totpVerified = true;
      await migrateOldDocIfNeeded(uid);
      attachFirestoreListener(uid);
      startHardSessionTimer();
    };
    document.getElementById("totpEnrollSubmit").addEventListener("click", submit);
    document.getElementById("totpEnrollCode").addEventListener("keydown",(e)=>{ if(e.key==="Enter") submit(); });
    document.getElementById("totpEnrollCancel").addEventListener("click",(e)=>{ e.preventDefault(); fbAuth.signOut(); });
  }

  fbAuth.onAuthStateChanged((user) => {
    if(user){
      db.collection('ledgers').doc(user.uid).get().then((snap)=>{
        const settings = (snap.exists && snap.data().settings) || {};        const isGoogle = user.providerData.some(p=>p.providerId==='google.com');
        if(settings.totpEnabled && settings.totpSecret && !totpVerified){
          renderTotpLoginGate(user.uid, settings.totpSecret);        } else if(isGoogle && !totpVerified){
          renderTotpEnrollGate(user.uid, user.email);
        } else {
          totpVerified = true;
          migrateOldDocIfNeeded(user.uid).then(()=>{
            attachFirestoreListener(user.uid);
            startHardSessionTimer();
          });
        }
      }).catch(()=>{
        // offline or read error: don't lock the account out, proceed normally
        totpVerified = true;
        attachFirestoreListener(user.uid);
        startHardSessionTimer();
      });
    } else {
      if(firestoreUnsub){ firestoreUnsub(); firestoreUnsub = null; }
      stopHardSessionTimer();
      totpVerified = false;
      incomeListUnlocked = false;
      ready = false;
      renderAuthGate('login');
    }
  });

    const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;
  const MAX_SESSION_MS = 30 * 60 * 1000;
  const SESSION_START_KEY = 'authSessionStartAt';
  const LAST_ACTIVE_KEY = 'authLastActiveAt';
  let sessionTimer = null, activityBound = false, lastActivityWrite = 0;
  function markActivity(){
    if(!sessionTimer) return;
    const now = Date.now();
    if(now - lastActivityWrite < 1000) return;
    lastActivityWrite = now;
    localStorage.setItem(LAST_ACTIVE_KEY, String(now));
  }
  function checkSession(){
    const now = Date.now();
    const start = parseInt(localStorage.getItem(SESSION_START_KEY), 10);
    const last = parseInt(localStorage.getItem(LAST_ACTIVE_KEY), 10);
    if(start && now - start >= MAX_SESSION_MS){ fbAuth.signOut(); showToast("انتهت الجلسة بعد ٣٠ دقيقة من الاستخدام"); return; }
    if(last && now - last >= INACTIVITY_LIMIT_MS){ fbAuth.signOut(); showToast("تم تسجيل الخروج لعدم النشاط ١٠ دقائق"); }
  }
  function startHardSessionTimer(){
    if(sessionTimer) clearInterval(sessionTimer);
    const now = Date.now();
    if(!parseInt(localStorage.getItem(SESSION_START_KEY), 10)) localStorage.setItem(SESSION_START_KEY, String(now));
    if(!parseInt(localStorage.getItem(LAST_ACTIVE_KEY), 10)) localStorage.setItem(LAST_ACTIVE_KEY, String(now));
    if(!activityBound){
      ['click','keydown','touchstart','scroll','mousemove','input'].forEach(ev=>window.addEventListener(ev, markActivity, {passive:true, capture:true}));
      activityBound = true;
    }
    sessionTimer = setInterval(checkSession, 15000);
    checkSession();
  }
  function stopHardSessionTimer(){
    if(sessionTimer){ clearInterval(sessionTimer); sessionTimer = null; }
    localStorage.removeItem(SESSION_START_KEY);
    localStorage.removeItem(LAST_ACTIVE_KEY);
  }

  const appEl = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  function showToast(msg){ toastEl.textContent = msg; toastEl.classList.add("show"); setTimeout(()=>toastEl.classList.remove("show"), 2200); }

  // ---------- generic share-to-outside-apps helper (WhatsApp, etc.) ----------
  async function shareText(title, text){
    if(navigator.share){
      try{ await navigator.share({ title, text }); return; }
      catch(e){ if(e && e.name === 'AbortError') return; /* fall through to clipboard on other errors */ }
    }
    try{
      await navigator.clipboard.writeText(text);
      showToast("لا تتوفر مشاركة مباشرة على هذا الجهاز — تم نسخ النص لتشاركه يدوياً");
    }catch(e){
      showToast("تعذّرت المشاركة على هذا الجهاز");
    }
  }

  // ---------- render a title + lines of text into a PNG image (for sharing as an image) ----------
  async function textToImageBlob(title, lines){
    try{ if(document.fonts && document.fonts.ready) await document.fonts.ready; }catch(e){}
    const width = 720;
    const lineHeight = 30;
    const padding = 26;
    const titleHeight = 46;
    const height = padding*2 + titleHeight + Math.max(1,lines.length)*lineHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0,0,width,height);
    ctx.fillStyle = '#16283f';
    ctx.fillRect(0,0,width,6);
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#16283f';
    ctx.font = "bold 22px 'Cairo', 'Tajawal', Arial, sans-serif";
    ctx.fillText(title, width-padding, padding+6);
    ctx.strokeStyle = '#ddd3ba';
    ctx.beginPath();
    ctx.moveTo(padding, padding+titleHeight-8);
    ctx.lineTo(width-padding, padding+titleHeight-8);
    ctx.stroke();
    ctx.font = "15px 'Tajawal', Arial, sans-serif";
    ctx.fillStyle = '#1c2430';
    let y = padding + titleHeight;
    for(const line of lines){
      ctx.fillText(line, width-padding, y);
      y += lineHeight;
    }
    return new Promise(resolve=> canvas.toBlob(resolve, 'image/png'));
  }

  // ---------- share a PNG blob as a file with other apps outside the system ----------
  async function shareBlob(title, blob, filename){
    const safeName = (filename||title||'مشاركة').replace(/[\\/:*?"<>|]/g,'').trim() || 'مشاركة';
    const file = new File([blob], safeName + '.png', {type:'image/png'});
    if(navigator.canShare && navigator.canShare({files:[file]})){
      try{ await navigator.share({ title, files:[file] }); return; }
      catch(e){ if(e && e.name === 'AbortError') return; }
    }
    if(navigator.share){
      try{ await navigator.share({ title }); return; }
      catch(e){ if(e && e.name === 'AbortError') return; }
    }
    // fallback: download the image so it can be shared manually
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = safeName + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    showToast("لا تتوفر مشاركة مباشرة على هذا الجهاز — تم تنزيل الصورة لتشاركها يدوياً");
  }

  // ---------- share a title + lines of text as a plain generated image ----------
  async function shareImage(title, lines, filename){
    let blob;
    try{ blob = await textToImageBlob(title, lines); }
    catch(e){ showToast("تعذّر إنشاء صورة المشاركة"); return; }
    if(!blob){ showToast("تعذّر إنشاء صورة المشاركة"); return; }
    await shareBlob(title, blob, filename);
  }

  // ---------- temporarily remove height caps / scrollbars so a full capture includes every row, ----------
  // even when the content is longer than the box normally shows on screen (restored right after).
  function expandScrollAreas(root){
    const targets = [root, ...root.querySelectorAll('.table-wrap, .diff-box')];
    const saved = targets.map(el=>({ el, maxHeight: el.style.maxHeight, overflow: el.style.overflow, overflowY: el.style.overflowY, height: el.style.height }));
    targets.forEach(el=>{ el.style.maxHeight = 'none'; el.style.overflow = 'visible'; el.style.overflowY = 'visible'; el.style.height = 'auto'; });
    return () => saved.forEach(s=>{ s.el.style.maxHeight = s.maxHeight; s.el.style.overflow = s.overflow; s.el.style.overflowY = s.overflowY; s.el.style.height = s.height; });
  }

  // ---------- share an on-screen element as an image, exactly as it appears in the app ----------
  async function shareBlobs(title, blobs, filename){
    if(blobs.length === 1) return shareBlob(title, blobs[0], filename);
    const safe = (filename||title||'مشاركة').replace(/[\\/:*?"<>|]/g,'').trim() || 'مشاركة';
    const files = blobs.map((bl,i)=>new File([bl], safe + '-' + (i+1) + '.png', {type:'image/png'}));
    if(navigator.canShare && navigator.canShare({files})){
      try{ await navigator.share({ title, files }); return; }
      catch(e){ if(e && e.name === 'AbortError') return; }
    }
    files.forEach(fl=>{ const url = URL.createObjectURL(fl); const a = document.createElement('a'); a.href = url; a.download = fl.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(url), 4000); });
    showToast("لا تتوفر مشاركة مباشرة على هذا الجهاز — تم تنزيل الصور لتشاركها يدوياً");
  }
  async function shareElementAsImage(title, element, filename){
    if(typeof html2canvas !== 'function'){ showToast("تعذّر تحميل أداة التصوير — تحقق من اتصالك بالإنترنت"); return; }
    const hadWrap = document.body.classList.contains('wrap-cells');
    document.body.classList.add('wrap-cells');            // every cell shown in full, no "…" truncation
    const restore = expandScrollAreas(element);           // no height caps / scrollbars
    let canvas;
    try{
      const w0 = element.offsetWidth || 1, h0 = element.scrollHeight || 1;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);                         // same sharpness as the phone screen
      const sc = Math.max(1, Math.min(dpr, Math.sqrt(14e6 / (w0 * h0))));          // stay below the phone canvas memory limit
      canvas = await html2canvas(element, { backgroundColor: '#fffdf8', scale: sc, useCORS: true, windowWidth: document.documentElement.clientWidth || undefined });
    }catch(e){ restore(); if(!hadWrap) document.body.classList.remove('wrap-cells'); showToast("تعذّر إنشاء الصورة"); return; }
    restore(); if(!hadWrap) document.body.classList.remove('wrap-cells');
    const MAX = 12000, blobs = [];                         // very tall pages are cut into consecutive images
    for(let y = 0; y < canvas.height; y += MAX){
      const h = Math.min(MAX, canvas.height - y), part = document.createElement('canvas');
      part.width = canvas.width; part.height = h;
      part.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      blobs.push(await new Promise(r=>part.toBlob(r, 'image/png')));
    }
    if(blobs.some(x=>!x)){ showToast("تعذّر إنشاء الصورة"); return; }
    await shareBlobs(title, blobs, filename);
  }
  function uid(p){ return (p||'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,9); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtDate(d){ if(!d) return "—"; const dt=new Date(d); if(isNaN(dt)) return "—";
    return dt.toLocaleDateString('en-GB', {year:'numeric', month:'2-digit', day:'2-digit'}); }
  function fmtDateTime(d){ if(!d) return "—"; const dt=new Date(d); if(isNaN(dt)) return "—";
    return dt.toLocaleDateString('en-GB', {year:'numeric', month:'2-digit', day:'2-digit'}) + ' ' + dt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}); }
  function fmtTimeOnly(d){ const dt=new Date(d); if(isNaN(dt)) return "—"; return dt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}); }
  function num(n){ n = Number(n)||0; return n.toLocaleString('en-US', {maximumFractionDigits:2}); }
  function money(n){ return state.settings.showCurrency===false ? num(n) : num(n) + ' ' + state.settings.currency; }
  function daysSince(dateStr){ if(!dateStr) return Infinity; const d=new Date(dateStr); if(isNaN(d)) return Infinity;
    return Math.floor((Date.now()-d.getTime())/86400000); }

  // ---------- storage ----------
  // كل نوع بيانات محفوظ في مجموعة فرعية مستقلة (وليس حقلاً داخل مستند واحد) لتفادي
  // حد Firestore الصارم البالغ 1 ميغابايت لكل مستند. saveData() تقارن الحالة الحالية
  // بآخر نسخة معروفة من السيرفر (synced) وتكتب فقط ما تغيّر فعلياً.
  // Real-time updates arrive automatically via attachFirestoreListener()'s onSnapshot above.
  function diffAgainstSynced(current, syncedMap){
    const upserts = [], deletes = [], seen = new Set();
    (current||[]).forEach(item=>{
      if(!item || !item.id) return;
      seen.add(item.id);
      const prev = syncedMap[item.id];
      if(!prev || JSON.stringify(prev) !== JSON.stringify(item)) upserts.push(item);
    });
    Object.keys(syncedMap||{}).forEach(id=>{ if(!seen.has(id)) deletes.push(id); });
    return { upserts, deletes };
  }
  async function commitCollectionDiff(colRef, current, syncedMap){
    const { upserts, deletes } = diffAgainstSynced(current, syncedMap);
    if(upserts.length === 0 && deletes.length === 0) return;
    const ops = upserts.map(item => ({ set: [colRef.doc(item.id), item] }))
      .concat(deletes.map(id => ({ del: colRef.doc(id) })));
    for(let i=0; i<ops.length; i+=400){ // حد Firestore: 500 عملية كتابة كحد أقصى لكل batch
      const batch = db.batch();
      ops.slice(i, i+400).forEach(op=>{ op.set ? batch.set(op.set[0], op.set[1]) : batch.delete(op.del); });
      await batch.commit();
    }
  }
  async function saveData(){
    const user = fbAuth.currentUser;
    if(!user) return;
    try{
      const base = db.collection('ledgers').doc(user.uid);
      await base.set({ settings: state.settings }, { merge: true });
      await commitCollectionDiff(base.collection('customers'), state.customers, synced.customers);
      await commitCollectionDiff(base.collection('purchases'), state.purchases, synced.purchases);
      await commitCollectionDiff(base.collection('payments'), state.payments, synced.payments);
      await commitCollectionDiff(base.collection('history'), state.history, synced.history);
      for(const nm of ['accounts','supplierTx','inventory','cheques']) await commitCollectionDiff(base.collection(nm), state[nm], synced[nm]);
      if(saveStatus !== 'ok'){ saveStatus = 'ok'; render(); }
    }catch(e){
      console.error(e);
      if(saveStatus !== 'error'){ saveStatus = 'error'; render(); }
    }
  }

  // ---------- change history / archive ----------
  function logHistory(entityType, action, before, after){
    if(!state.history) state.history = [];
    state.history.push({
      id: uid('hist'),
      entityType, // 'customer' | 'sale' | 'receipt'
      action,     // 'create' | 'update' | 'delete'
      before: before || null,
      after: after || null,
      at: new Date().toISOString(),
    });
    // keep the log from growing without bound
    if(state.history.length > 2000) state.history = state.history.slice(-2000);
  }

  // ---------- customer lookups ----------
  function findCustomer(name){
    const key = (name||"").trim();
    return state.customers.find(c => c.name === key);
  }
  function ensureCustomerExists(name, phone){
    const key = (name||"").trim();
    if(!key) return;
    let c = findCustomer(key);
    if(!c){
      c = { id: uid('cus'), name:key, phone: phone||"", address:"", notes:"",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.customers.push(c);
      logHistory('customer', 'create', null, Object.assign({}, c));
    } else if(phone && !c.phone){
      const before = Object.assign({}, c);
      c.phone = phone; c.updatedAt = new Date().toISOString();
      logHistory('customer', 'update', before, Object.assign({}, c));
    }
  }
  function allCustomerNames(){
    const names = new Set(state.customers.map(c=>c.name));
    state.purchases.forEach(p=>names.add(p.customerName));
    state.payments.forEach(p=>names.add(p.customerName));
    return Array.from(names).filter(Boolean).sort();
  }

  // ---------- derived accounts ----------
  function stampCustomerIds(){
    const byName = {}; state.customers.forEach(c=>{ byName[c.name] = c.id; });
    let changed = false;
    ['purchases','payments'].forEach(k=>state[k].forEach(r=>{
      if(!r.customerId && byName[r.customerName]){ r.customerId = byName[r.customerName]; changed = true; }
    }));
    if(changed) saveData();
  }
  // cached wrapper: recompute only when the data actually changed (fixes slow re-render on every keystroke)
  let _accCache = null, _accSig = '';
  function computeAccounts(){
    const mx = a => a.reduce((m,x)=> (x.updatedAt||'') > m ? (x.updatedAt||'') : m, '');
    const sig = [state.purchases.length, state.payments.length, state.customers.length,
      mx(state.purchases), mx(state.payments), mx(state.customers), state.settings.overdueDays].join('|');
    if(_accCache && sig === _accSig) return _accCache;
    _accSig = sig; _accCache = computeAccountsRaw(); return _accCache;
  }
  function computeAccountsRaw(){
    const map = new Map();
    function get(name){
      const key = (name||"").trim() || "(بدون اسم)";
      if(!map.has(key)){
        const cust = findCustomer(key);
        map.set(key, {
          name:key, phone: cust?cust.phone:"", address: cust?cust.address:"", notes: cust?cust.notes:"",
          totalDebit:0, totalCredit:0, totalProfit:0,
          firstPurchase:null, lastActivity:null, lastPayment:null, purCount:0, payCount:0
        });
      }
      return map.get(key);
    }
    for(const p of state.purchases){
      const c = get(p.customerName);
      c.totalDebit += Number(p.price)||0;
      c.totalProfit += Number(p.profit)||0;
      c.purCount++;
      if(!c.firstPurchase || new Date(p.date) < new Date(c.firstPurchase)) c.firstPurchase = p.date;
      if(!c.lastPurchase || new Date(p.date) > new Date(c.lastPurchase)) c.lastPurchase = p.date;
      if(!c.lastActivity || new Date(p.date) > new Date(c.lastActivity)) c.lastActivity = p.date;
    }
    for(const p of state.payments){
      const c = get(p.customerName);
      c.totalCredit += Number(p.amount)||0;
      c.payCount++;
      if(isCashReceipt(p) && (!c.lastPayment || new Date(p.date) > new Date(c.lastPayment))) c.lastPayment = p.date;
      if(!c.lastActivity || new Date(p.date) > new Date(c.lastActivity)) c.lastActivity = p.date;
    }
    // include customers with zero activity too
    state.customers.forEach(cust => get(cust.name));
    const list = Array.from(map.values()).map(c=>{
      c.balance = c.totalDebit - c.totalCredit;
      c.collectedProfit = c.totalDebit > 0 ? c.totalProfit * Math.min(1, c.totalCredit/c.totalDebit) : 0;
      c.overdue = c.balance > 0.009 && daysSince(c.lastActivity) > (state.settings.overdueDays||45);
      c.paidOff = c.balance <= 0.009 && c.totalDebit > 0;
      c.hasPending = c.balance > 0.009;
      return c;
    });
    list.sort((a,b)=>(b.lastActivity||"").localeCompare(a.lastActivity||""));
    return list;
  }

  function datalistNames(id){
    return `<datalist id="${id}">${allCustomerNames().map(n=>`<option value="${esc(n)}">`).join('')}</datalist>`;
  }

  // ---------- shared customer/month/year filtering (used by every transactions screen) ----------
  function applyTxFilter(rows, filterObj, dateField){
    dateField = dateField || 'date';
    let out = rows;
    if(filterObj.customer) out = out.filter(p=>(p.customerName||'').toLowerCase().includes(filterObj.customer.trim().toLowerCase()));
    if(filterObj.year) out = out.filter(p=>{ const d=new Date(p[dateField]); return !isNaN(d) && String(d.getFullYear())===filterObj.year; });
    if(filterObj.month) out = out.filter(p=>{ const d=new Date(p[dateField]); return !isNaN(d) && String(d.getMonth()+1)===filterObj.month; });
    return out;
  }
  function txYearsFromDates(rows, dateField){
    dateField = dateField || 'date';
    return Array.from(new Set(rows.map(p=>{ const d=new Date(p[dateField]); return isNaN(d)?null:d.getFullYear(); }).filter(Boolean))).sort((a,b)=>b-a);
  }
  function monthYearFilterRow(prefix, filterObj, customerNames, years, includeCustomer){
    const hasFilter = !!(filterObj.customer || filterObj.month || filterObj.year);
    return `
      <div class="filters-row">
        ${includeCustomer ? `<div class="field">
          <label>العميل</label>
          <input type="text" id="${prefix}CustomerFilter" list="${prefix}CustomerFilterList" placeholder="كل العملاء" value="${esc(filterObj.customer||'')}">
          <datalist id="${prefix}CustomerFilterList">${customerNames.map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
        </div>` : ''}
        <div class="field">
          <label>الشهر</label>
          <select id="${prefix}MonthFilter">
            <option value="">كل الشهور</option>
            ${Array.from({length:12},(_,i)=>i+1).map(m=>`<option value="${m}" ${filterObj.month===String(m)?'selected':''}>${String(m).padStart(2,'0')}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>السنة</label>
          <select id="${prefix}YearFilter">
            <option value="">كل السنوات</option>
            ${years.map(y=>`<option value="${y}" ${filterObj.year===String(y)?'selected':''}>${y}</option>`).join('')}
          </select>
        </div>
        ${hasFilter ? `<div class="field"><label>&nbsp;</label><button class="btn-clear-blue" id="${prefix}ClearFilterBtn">إلغاء الفلترة</button></div>` : ''}
      </div>`;
  }
  function attachTxFilterListeners(prefix, filterObj, includeCustomer){
    if(includeCustomer){
      const c = document.getElementById(prefix+"CustomerFilter");
      if(c) c.addEventListener("input",(e)=>{ filterObj.customer = e.target.value; render(); });
    }
    const m = document.getElementById(prefix+"MonthFilter");
    if(m) m.addEventListener("change",(e)=>{ filterObj.month = e.target.value; render(); });
    const y = document.getElementById(prefix+"YearFilter");
    if(y) y.addEventListener("change",(e)=>{ filterObj.year = e.target.value; render(); });
    const clr = document.getElementById(prefix+"ClearFilterBtn");
    if(clr) clr.addEventListener("click", ()=>{ filterObj.customer=''; filterObj.month=''; filterObj.year=''; render(); });
  }

  // ---------- shared column visibility (synced across every screen that has the column) ----------
  // Single master list — controlled exclusively from the Settings page.
  const COLUMN_FIELDS = [
    {key:'date', label:'التاريخ (البيع / القبض)'},
    {key:'product', label:'المنتج'},
    {key:'price', label:'السعر'},
    {key:'cost', label:'التكلفة (قائمة الدخل)'},
    {key:'profit', label:'الربح (قائمة الدخل)'},
    {key:'supplier', label:'المورّد (قائمة الدخل)'},
    {key:'amount', label:'المبلغ'},
    {key:'createdAt', label:'تاريخ الإنشاء'},
    {key:'phone', label:'رقم الهاتف (بيانات العملاء)'},
    {key:'address', label:'العنوان (بيانات العملاء)'},
    {key:'notes', label:'ملاحظات'},
    {key:'actions', label:'أيقونات التعديل والحذف'},
  ];
  function colVisible(key){
    return !(state.settings.columns && state.settings.columns[key]===false);
  }

  function renderColumnsSettingsCard(){
    return `
      <div class="card">
        <div class="card-head"><h2>عرض الجداول</h2></div>
        <div class="field" style="max-width:360px;margin-bottom:16px">
          <label>التفاف النص داخل الجداول</label>
          <select id="wrapCellsInput">
            <option value="no" ${!state.settings.wrapCells?'selected':''}>عرض في سطر واحد مع قص الزائد (…)</option>
            <option value="yes" ${state.settings.wrapCells?'selected':''}>التفاف النص وعرضه كاملاً على عدة أسطر</option>
          </select>
          <div class="hint">يُطبَّق تلقائياً على جميع الجداول في كل الشاشات (العملاء، المبيعات، المقبوضات، التقارير...).</div>
        </div>
        <div class="card-head" style="margin-bottom:10px"><h2 style="font-size:14.5px">التحكم بعرض الأعمدة</h2></div>
        <p class="hint" style="margin-bottom:12px">إخفاء أو إظهار أي عمود يُطبَّق تلقائياً على كل الشاشات التي تحتوي على نفس العمود.</p>
        <div class="grid2">
          ${COLUMN_FIELDS.map(f=>`
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer">
              <input type="checkbox" data-colkey="${f.key}" ${colVisible(f.key)?'checked':''}> ${esc(f.label)}
            </label>`).join('')}
        </div>
      </div>`;
  }

  // ---------- render shell ----------
  function render(){
    if(!ready){ appEl.innerHTML = '<div class="app-loading">جارِ التحميل…</div>'; return; }

    // remember focus + cursor position so re-rendering doesn't kick the user out of a text field
    const active = document.activeElement;
    const activeId = active && active.id;
    const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const selEnd = active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;

    stampCustomerIds();
    const accounts = computeAccounts();

    document.body.classList.toggle("wrap-cells", !!state.settings.wrapCells);
    document.body.classList.toggle("staff", isStaff());
    pagingSync();
    if(isStaff() && (currentTab==="finance" || currentTab==="reports")) currentTab = "customers";

    appEl.innerHTML = `
      <div class="topbar">
        <div class="brand">
          <div class="brand-mark">أ</div>
          <div class="brand-text"><h1>مكة للهواتف الذكية</h1>${isStaff()?'<span class="badge badge-warn" id="exitStaffBtn" style="cursor:pointer">وضع الموظف — اضغط للخروج</span>':''}</div>
        </div>
      </div>
      ${saveStatus==='error' ? `
      <div class="save-warning">⚠️ تعذر الاتصال بقاعدة البيانات — تحقق من اتصال الإنترنت. تعديلاتك محفوظة مؤقتاً في هذا الجهاز وستتزامن تلقائياً عند عودة الاتصال</div>
      ` : ''}
      <div class="tabs">
        <button class="tabbtn" style="background:var(--brass);border-color:var(--brass);color:var(--navy)" id="quickAddBtn">+ إضافة</button>
        
        
        
        <button class="tabbtn ${FIN_TABS.includes(currentTab)?'active':''}" data-tab="fin">المالية</button>
        <button class="tabbtn ${currentTab==='reports'?'active':''}" data-tab="reports">التقارير</button>
      </div>
      <div id="tabContent"></div>
    `;
    document.querySelectorAll(".tabbtn[data-tab]").forEach(b=>b.addEventListener("click", ()=>{ currentTab = b.dataset.tab==='fin' ? (FIN_TABS.includes(currentTab) ? currentTab : 'customers') : b.dataset.tab; render(); }));
    document.getElementById("quickAddBtn").addEventListener("click", openQuickAddMenu);
    const exitStaff = document.getElementById("exitStaffBtn"); if(exitStaff) exitStaff.addEventListener("click", exitStaffMode);

    const content = document.getElementById("tabContent");
    if(currentTab==="customers") content.innerHTML = renderCustomersInfo();
    else if(currentTab==="purchases") content.innerHTML = renderPurchases();
    else if(currentTab==="payments") content.innerHTML = renderPayments();
    else if(currentTab==="finance") content.innerHTML = window.Ext.render();
    else content.innerHTML = renderReports(accounts);
    if(FIN_TABS.includes(currentTab)){
      content.innerHTML = finNav() + content.innerHTML;
      content.querySelectorAll('[data-fin]').forEach(b=>b.addEventListener('click', ()=>finGo(b.dataset.fin)));
    }

    bindEvents(accounts);
    pagingButton();

    // restore focus + cursor position (e.g. search boxes) after the re-render above
    if(activeId){
      const el = document.getElementById(activeId);
      if(el && typeof el.focus === 'function'){
        el.focus();
        if(selStart !== null && typeof el.setSelectionRange === 'function'){
          try{ el.setSelectionRange(selStart, selEnd); }catch(e){}
        }
      }
    }
  }

  // ---------- customers info page ----------
  function renderCustomersInfo(){
    let list = state.customers.slice();
    const q = search.customers.trim().toLowerCase();
    if(q) list = list.filter(c => c.name.toLowerCase().includes(q));
    list.sort((a,b)=>a.name.localeCompare(b.name,'ar'));
    return `
      <div class="card">
        <div class="card-head">
          <h2>معلومات العملاء</h2>
          <div class="row">
            <input type="text" id="searchCustomers" list="customerNamesList" placeholder="بحث باسم العميل" value="${esc(search.customers)}" style="min-width:230px">
          </div>
        </div>
        ${list.length===0 ? emptyState('لا يوجد عملاء بعد', 'أضف أول عميل، أو أضف عملية بيع/قبض وسيُنشأ العميل تلقائياً.') : `
        <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width:111px">
            ${colVisible('phone')?'<col style="width:99px">':''}
            ${colVisible('address')?'<col style="width:auto">':''}
            ${colVisible('notes')?'<col style="width:110px">':''}
            ${colVisible('actions')?'<col style="width:64px">':''}
          </colgroup>
          <thead><tr><th>الاسم</th>${colVisible('phone')?'<th>رقم الهاتف</th>':''}${colVisible('address')?'<th>العنوان</th>':''}${colVisible('notes')?'<th>ملاحظات</th>':''}${colVisible('actions')?'<th></th>':''}</tr></thead>
          <tbody>
            ${pgSlice('customers', list).map(c=>`
              <tr>
                <td class="name-cell">${esc(c.name)}</td>
                ${colVisible('phone')?`<td class="muted">${esc(c.phone)||'—'}</td>`:''}
                ${colVisible('address')?`<td class="muted" style="white-space:normal">${esc(c.address)||'—'}</td>`:''}
                ${colVisible('notes')?`<td class="muted" dir="auto" style="white-space:normal">${esc(c.notes)||'—'}</td>`:''}
                ${colVisible('actions')?`<td><button class="icon-btn" data-editcust="${c.id}" title="تعديل">✎</button>
                    <button class="icon-btn" data-delcust="${c.id}" title="حذف">✕</button></td>`:''}
              </tr>`).join('')}
          </tbody>
        </table></div>`}
      </div>
      ${datalistNames('customerNamesList')}
    `;
  }

  function openQuickAddMenu(){
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.style.alignItems = "flex-start";
    wrap.style.paddingTop = "12vh";
    wrap.innerHTML = `
      <div class="modal" style="max-width:320px">
        <h3>إضافة جديد</h3>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:10px;margin-top:14px">
          <button class="btn btn-primary" id="qaPayment">+ إضافة قبض</button>
          <button class="btn btn-primary" id="qaPurchase">+ إضافة عملية بيع</button>
          <button class="btn btn-primary" id="qaCustomer">+ إضافة عميل</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
    document.getElementById("qaCustomer").addEventListener("click", ()=>{ document.body.removeChild(wrap); openCustomerModal(null); });
    document.getElementById("qaPurchase").addEventListener("click", ()=>{ document.body.removeChild(wrap); openPurchaseModal(null); });
    document.getElementById("qaPayment").addEventListener("click", ()=>{ document.body.removeChild(wrap); openPaymentModal(null); });
  }
  function openCustomerModal(id){
    const editing = id ? state.customers.find(c=>c.id===id) : null;
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = `
      <div class="modal">
        <h3>${editing?'تعديل بيانات عميل':'إضافة عميل جديد'}</h3>
        <div class="grid2">
          <div class="field grow"><label>اسم العميل *</label><input type="text" id="cf_name" value="${editing?esc(editing.name):''}"></div>
          <div class="field"><label>رقم الهاتف</label><input type="text" id="cf_phone" value="${editing?esc(editing.phone):''}"></div>
          <div class="field grow"><label>العنوان</label><input type="text" id="cf_address" value="${editing?esc(editing.address):''}"></div>
          <div class="field grow"><label>ملاحظات</label><input type="text" id="cf_notes" dir="auto" value="${editing?esc(editing.notes):''}"></div>
          <div class="field"><label>حد الدين (اختياري)</label><input type="number" id="cf_limit" value="${editing&&editing.creditLimit?editing.creditLimit:''}"></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancelBtn">إلغاء</button>
          <button class="btn btn-primary" id="saveBtn">${editing?'حفظ التعديلات':'إضافة'}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
    document.getElementById("cancelBtn").addEventListener("click", ()=>document.body.removeChild(wrap));
    document.getElementById("saveBtn").addEventListener("click", ()=>{
      const name = document.getElementById("cf_name").value.trim();
      if(!name){ showToast("الرجاء إدخال اسم العميل"); return; }
      const dup = findCustomer(name); if(dup && (!editing || dup.id !== editing.id)){ showToast("يوجد عميل بهذا الاسم مسبقاً"); return; }
      const now = new Date().toISOString();
      const data = { name, phone: document.getElementById("cf_phone").value.trim(),
        address: document.getElementById("cf_address").value.trim(), notes: document.getElementById("cf_notes").value.trim(),
        creditLimit: parseFloat(document.getElementById("cf_limit").value)||0 };
      if(editing){
        const before = Object.assign({}, editing);
        const oldName = editing.name;
        Object.assign(editing, data, {updatedAt: now});
        if(oldName !== data.name){
          state.purchases.forEach(p=>{ if(p.customerId===editing.id || p.customerName===oldName) p.customerName = data.name; });
          (state.cheques||[]).forEach(c=>{ if(c.customer===oldName) c.customer = data.name; });
          state.payments.forEach(p=>{ if(p.customerId===editing.id || p.customerName===oldName) p.customerName = data.name; });
        }
        logHistory('customer', 'update', before, Object.assign({}, editing));
        showToast("تم حفظ التعديلات");
      } else {
        const newCust = Object.assign({id:uid('cus'), createdAt:now, updatedAt:now}, data);
        state.customers.push(newCust);
        logHistory('customer', 'create', null, Object.assign({}, newCust));
        showToast("تمت إضافة العميل");
      }
      saveData(); document.body.removeChild(wrap); render();
    });
  }

  function deleteCustomer(id){
    const c = state.customers.find(x=>x.id===id);
    if(!c) return;
    const hasRecords = state.purchases.some(p=>p.customerName===c.name) || state.payments.some(p=>p.customerName===c.name);
    const msg = hasRecords
      ? "هذا العميل لديه عمليات بيع أو قبض مسجلة. سيتم حذف بياناته الشخصية فقط (سيبقى اسمه في السجلات). متابعة؟"
      : "هل تريد حذف هذا العميل؟";
    if(!confirm(msg)) return;
    state.customers = state.customers.filter(x=>x.id!==id);
    logHistory('customer', 'delete', Object.assign({}, c), null);
    saveData(); showToast("تم حذف العميل"); render();
  }

  // ---------- purchases page ----------
  let purchasesFilter = { customer:'', month:'', year:'' };
  function renderPurchases(){
    let list = state.purchases.slice();
    list = applyTxFilter(list, purchasesFilter);
    list.sort((a,b)=> sortDesc ? (b.date||"").localeCompare(a.date||"") : (a.date||"").localeCompare(b.date||""));
    const totalPrice = list.reduce((s,p)=>s+(Number(p.price)||0),0);
    const totalCost = list.reduce((s,p)=>s+(Number(p.cost)||0),0);
    const totalProfit = list.reduce((s,p)=>s+(Number(p.profit)||0),0);
    list = pgSlice('purchases', list);
    const years = txYearsFromDates(state.purchases);
    const customerNames = allCustomerNames();
    return `
      <div class="card">
        <div class="card-head">
          <h2>المبيعات</h2>
          <div class="row">
            <button class="btn btn-ghost btn-sort-sm" id="sortBtn">${sortDesc?'الأحدث أولاً ▾':'الأقدم أولاً ▴'}</button>
          </div>
        </div>
        ${monthYearFilterRow('pur', purchasesFilter, customerNames, years, true, true)}
        <p class="hint">${pgInfo.total} عملية</p>
        ${list.length===0 ? emptyState('لا توجد مشتريات ضمن هذه الفلترة','') : `
        <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width:104px">
            ${colVisible('date')?'<col style="width:83px">':''}
            ${colVisible('product')?'<col style="width:110px">':''}
            ${colVisible('price')?'<col style="width:48px">':''}
            ${colVisible('createdAt')?'<col class="hide-mobile" style="width:120px">':''}
            ${colVisible('actions')?'<col style="width:64px">':''}
          </colgroup>
          <thead><tr><th>العميل</th>${colVisible('date')?'<th>تاريخ البيع</th>':''}${colVisible('product')?'<th>المنتج</th>':''}${colVisible('price')?'<th>السعر</th>':''}${colVisible('createdAt')?'<th class="hide-mobile">تاريخ الإنشاء</th>':''}${colVisible('actions')?'<th></th>':''}</tr></thead>
          <tbody>
            ${list.map(p=>`
              <tr>
                <td class="name-cell">${esc(p.customerName)}</td>
                ${colVisible('date')?`<td class="muted">${fmtDate(p.date)}</td>`:''}
                ${colVisible('product')?`<td dir="auto" style="white-space:normal">${esc(p.productName)||'—'}</td>`:''}
                ${colVisible('price')?`<td class="num">${money(p.price)}</td>`:''}
                ${colVisible('createdAt')?`<td class="muted hide-mobile" style="font-size:12px">${fmtDateTime(p.createdAt)}</td>`:''}
                ${colVisible('actions')?`<td><button class="icon-btn" data-editpur="${p.id}" title="تعديل">✎</button>
                    <button class="icon-btn" data-delpur="${p.id}" title="حذف">✕</button></td>`:''}
              </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td style="font-weight:800">الإجمالي</td>
            ${colVisible('date')?'<td></td>':''}
            ${colVisible('product')?'<td></td>':''}
            ${colVisible('price')?`<td class="num" style="font-weight:800">${money(totalPrice)}</td>`:''}
            ${colVisible('createdAt')?'<td class="hide-mobile"></td>':''}
            ${colVisible('actions')?'<td></td>':''}
          </tr></tfoot>
        </table></div>`}
      </div>
      ${datalistNames('customerNamesList')}
    `;
  }

  function openPurchaseModal(id){
    const editing = id ? state.purchases.find(p=>p.id===id) : null;
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = `
      <div class="modal">
        <h3>${editing?'تعديل عملية بيع':'إضافة عملية بيع'}</h3>
        <div class="grid2">
          <div class="field grow"><label>اسم العميل *</label><input type="text" id="pf_name" list="customerNamesModalList" value="${editing?esc(editing.customerName):''}"></div>
          <div class="field"><label>تاريخ البيع *</label><input type="date" id="pf_date" lang="en-GB" dir="ltr" value="${editing?(editing.date||'').slice(0,10):new Date().toISOString().slice(0,10)}"></div>
          <div class="field grow"><label>اسم المنتج</label><input type="text" id="pf_product" dir="auto" value="${editing?esc(editing.productName):''}" placeholder="مثال: Redmi 13C 256"></div>
          <div class="field"><label>السعر *</label><input type="number" id="pf_price" value="${editing&&editing.price?editing.price:''}"></div>
          <div class="field"><label>التكلفة</label><input type="number" id="pf_cost" value="${editing&&editing.cost?editing.cost:''}"></div>
          <div class="field grow"><label>المورّد</label><input type="text" id="pf_supplier" value="${editing?esc(editing.supplier):''}"></div>
          <div class="field grow"><label>ملاحظات</label><input type="text" id="pf_notes" dir="auto" value="${editing?esc(editing.notes):''}"></div>
          <div class="field"><label>الربح (تلقائي)</label><input type="number" id="pf_profit_display" value="${editing?((editing.price||0)-(editing.cost||0)):0}" disabled style="background:#f2ede0;color:var(--muted)"></div>
        </div>
        <p class="hint">الربح يُحتسب تلقائياً = السعر − التكلفة.</p>
        ${datalistNames('customerNamesModalList')}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancelBtn">إلغاء</button>
          <button class="btn btn-primary" id="saveBtn">${editing?'حفظ التعديلات':'إضافة'}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const updateProfitDisplay = () => {
      const price = parseFloat(document.getElementById("pf_price").value)||0;
      const cost = parseFloat(document.getElementById("pf_cost").value)||0;
      document.getElementById("pf_profit_display").value = price - cost;
    };
    document.getElementById("pf_price").addEventListener("input", updateProfitDisplay);
    document.getElementById("pf_cost").addEventListener("input", updateProfitDisplay);
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
    document.getElementById("cancelBtn").addEventListener("click", ()=>document.body.removeChild(wrap));
    document.getElementById("saveBtn").addEventListener("click", ()=>{
      const name = document.getElementById("pf_name").value.trim();
      const price = parseFloat(document.getElementById("pf_price").value)||0;
      if(!name){ showToast("الرجاء إدخال اسم العميل"); return; }
      if(!price){ showToast("الرجاء إدخال السعر"); return; }
      if(isLocked(document.getElementById("pf_date").value) || (editing && isLocked(editing.date))){ showToast("هذه الفترة مقفلة ولا يمكن تعديل حركاتها"); return; }
      { const lim = creditLimitOf(name);
        if(lim > 0){
          const prior = balanceOf(name) - ((editing && editing.customerName===name) ? (Number(editing.price)||0) : 0);
          if(prior + price > lim && !confirm('تنبيه: بعد هذه العملية سيصبح رصيد "' + name + '" ' + money(prior+price) + ' وهو يتجاوز حد الدين ' + money(lim) + '. هل تريد المتابعة؟')) return;
        } }
      const now = new Date().toISOString();
      const cost = parseFloat(document.getElementById("pf_cost").value)||0;
      const data = {
        customerName:name, date: document.getElementById("pf_date").value || now.slice(0,10),
        productName: document.getElementById("pf_product").value.trim(), price,
        cost, profit: price - cost,
        supplier: document.getElementById("pf_supplier").value.trim(),
        notes: document.getElementById("pf_notes").value.trim(),
      };
      ensureCustomerExists(name);
      if(editing){
        const before = Object.assign({}, editing);
        Object.assign(editing, data, {updatedAt: now});
        logHistory('sale', 'update', before, Object.assign({}, editing));
        showToast("تم حفظ التعديلات");
      } else {
        data.id=uid('pur'); data.createdAt=now; data.updatedAt=now;
        state.purchases.push(data);
        logHistory('sale', 'create', null, Object.assign({}, data));
        showToast("تمت إضافة عملية البيع");
      }
      saveData(); document.body.removeChild(wrap); render();
    });
  }

  // ---------- payments page ----------
  let paymentsFilter = { customer:'', month:'', year:'' };
  function renderPayments(){
    let list = state.payments.slice();
    list = applyTxFilter(list, paymentsFilter);
    list.sort((a,b)=> sortDesc ? (b.date||"").localeCompare(a.date||"") : (a.date||"").localeCompare(b.date||""));
    const totalAmount = list.reduce((s,p)=>s+(Number(p.amount)||0),0);
    list = pgSlice('payments', list);
    const years = txYearsFromDates(state.payments);
    const customerNames = allCustomerNames();
    return `
      <div class="card">
        <div class="card-head">
          <h2>المقبوضات</h2>
          <div class="row">
            <button class="btn btn-ghost btn-sort-sm" id="sortBtn">${sortDesc?'الأحدث أولاً ▾':'الأقدم أولاً ▴'}</button>
          </div>
        </div>
        ${monthYearFilterRow('pay', paymentsFilter, customerNames, years, true, true)}
        <p class="hint">${pgInfo.total} عملية قبض</p>
        ${list.length===0 ? emptyState('لا توجد عمليات قبض ضمن هذه الفلترة','') : `
        <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width:104px">
            ${colVisible('date')?'<col style="width:83px">':''}
            ${colVisible('amount')?'<col style="width:50px">':''}
            ${colVisible('createdAt')?'<col class="hide-mobile" style="width:120px">':''}
            ${colVisible('notes')?'<col style="width:110px">':''}
            ${colVisible('actions')?'<col style="width:64px">':''}
          </colgroup>
          <thead><tr><th>العميل</th>${colVisible('date')?'<th>تاريخ القبض</th>':''}${colVisible('amount')?'<th>المبلغ</th>':''}${colVisible('createdAt')?'<th class="hide-mobile">تاريخ الإنشاء</th>':''}${colVisible('notes')?'<th>الملاحظات</th>':''}${colVisible('actions')?'<th></th>':''}</tr></thead>
          <tbody>
            ${list.map(p=>`
              <tr>
                <td class="name-cell">${esc(p.customerName)}</td>
                ${colVisible('date')?`<td class="muted">${fmtDate(p.date)}</td>`:''}
                ${colVisible('amount')?`<td class="num">${money(p.amount)}${isCashReceipt(p)?'':` <span class="badge badge-warn">${p.kind==='discount'?'خصم':'مرتجع'}</span>`}</td>`:''}
                ${colVisible('createdAt')?`<td class="muted hide-mobile" style="font-size:12px">${fmtDateTime(p.createdAt)}</td>`:''}
                ${colVisible('notes')?`<td class="muted" dir="auto" style="white-space:normal">${esc(p.notes)||'—'}</td>`:''}
                ${colVisible('actions')?`<td><button class="icon-btn" data-editpay="${p.id}" title="تعديل">✎</button>
                    <button class="icon-btn" data-delpay="${p.id}" title="حذف">✕</button></td>`:''}
              </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td style="font-weight:800">الإجمالي</td>
            ${colVisible('date')?'<td></td>':''}
            ${colVisible('amount')?`<td class="num" style="font-weight:800">${money(totalAmount)}</td>`:''}
            ${colVisible('createdAt')?'<td class="hide-mobile"></td>':''}
            ${colVisible('notes')?'<td></td>':''}
            ${colVisible('actions')?'<td></td>':''}
          </tr></tfoot>
        </table></div>`}
      </div>
      ${datalistNames('customerNamesList')}
    `;
  }

  function openPaymentModal(id){
    const editing = id ? state.payments.find(p=>p.id===id) : null;
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = `
      <div class="modal">
        <h3>${editing?'تعديل قبض':'إضافة قبض'}</h3>
        <div class="grid2">
          <div class="field grow"><label>اسم العميل *</label><input type="text" id="pyf_name" list="customerNamesModalList" value="${editing?esc(editing.customerName):''}"></div>
          <div class="field"><label>تاريخ القبض *</label><input type="date" id="pyf_date" lang="en-GB" dir="ltr" value="${editing?(editing.date||'').slice(0,10):new Date().toISOString().slice(0,10)}"></div>
          <div class="field"><label>المبلغ *</label><input type="number" id="pyf_amount" value="${editing&&editing.amount?editing.amount:''}"></div>
          <div class="field grow"><label>ملاحظات</label><input type="text" id="pyf_notes" dir="auto" value="${editing?esc(editing.notes):''}"></div>
          <div class="field"><label>النوع</label><select id="pyf_kind">
            <option value="payment" ${!editing||!editing.kind||editing.kind==='payment'?'selected':''}>قبض</option>
            <option value="discount" ${editing&&editing.kind==='discount'?'selected':''}>خصم</option>
            <option value="return" ${editing&&editing.kind==='return'?'selected':''}>مرتجع</option></select></div>
          <div class="field"><label>أثر على الربح (خصم = المبلغ تلقائياً · مرتجع = ربح الجهاز المرتجع)</label><input type="number" id="pyf_profitadj" value="${editing&&editing.profitAdj!=null?editing.profitAdj:''}"></div>
          <div class="field" style="grid-column:1/-1"><label>الجهاز المرتجع (يعود للمخزون — للمرتجعات فقط)</label><select id="pyf_returnitem"><option value="">—</option>${(state.inventory||[]).filter(i=>i.status==='sold'||(editing&&i.id===editing.returnItemId)).map(i=>`<option value="${i.id}" ${editing&&editing.returnItemId===i.id?'selected':''}>${esc(i.name)}${i.imei?' · '+esc(i.imei):''} · ${i.cost}</option>`).join('')}</select></div>
          <div class="field"><label>الحساب</label><select id="pyf_account"><option value="">—</option>${(state.accounts||[]).map(a=>`<option value="${a.id}" ${editing&&editing.accountId===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div>
        </div>
        ${datalistNames('customerNamesModalList')}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancelBtn">إلغاء</button>
          <button class="btn btn-primary" id="saveBtn">${editing?'حفظ التعديلات':'إضافة'}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
    document.getElementById("cancelBtn").addEventListener("click", ()=>document.body.removeChild(wrap));
    document.getElementById("saveBtn").addEventListener("click", ()=>{
      const name = document.getElementById("pyf_name").value.trim();
      const amount = parseFloat(document.getElementById("pyf_amount").value)||0;
      if(!name){ showToast("الرجاء إدخال اسم العميل"); return; }
      if(!amount){ showToast("الرجاء إدخال المبلغ"); return; }
      if(isLocked(document.getElementById("pyf_date").value) || (editing && isLocked(editing.date))){ showToast("هذه الفترة مقفلة ولا يمكن تعديل حركاتها"); return; }
      const now = new Date().toISOString();
      const data = { customerName:name, date: document.getElementById("pyf_date").value || now.slice(0,10), amount,
        notes: document.getElementById("pyf_notes").value.trim(), accountId: document.getElementById("pyf_account").value, kind: document.getElementById("pyf_kind").value,
        profitAdj: document.getElementById("pyf_profitadj").value === "" ? null : (parseFloat(document.getElementById("pyf_profitadj").value)||0) };
      // return linked to a stock device: auto profit adjustment (the original sale's profit) and put the device back in stock
      const retSel = document.getElementById("pyf_returnitem").value;
      data.returnItemId = (data.kind === "return" && retSel) ? retSel : null;
      if(data.returnItemId && data.profitAdj === null){
        const it0 = (state.inventory||[]).find(i=>i.id===data.returnItemId);
        const sp0 = it0 && state.purchases.find(p=>p.id===it0.purchaseId);
        if(sp0) data.profitAdj = Number(sp0.profit)||0;
      }
      applyReturnLink(editing || {}, data.returnItemId);
      ensureCustomerExists(name);
      if(editing){
        const before = Object.assign({}, editing);
        Object.assign(editing, data, {updatedAt: now});
        logHistory('receipt', 'update', before, Object.assign({}, editing));
        showToast("تم حفظ التعديلات");
      } else {
        data.id=uid('pay'); data.createdAt=now; data.updatedAt=now;
        state.payments.push(data);
        logHistory('receipt', 'create', null, Object.assign({}, data));
        showToast("تمت إضافة عملية القبض");
      }
      saveData(); document.body.removeChild(wrap); render();
    });
  }

  // ---------- statements (account balances) ----------
  function computeMonthlyStats(){
    const map = new Map(); // 'YYYY-MM' -> {sales, cost, collections}
    function key(dateStr){
      const d = new Date(dateStr);
      if(isNaN(d)) return null;
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    }
    function get(k){
      if(!map.has(k)) map.set(k, {sales:0, cost:0, collections:0});
      return map.get(k);
    }
    for(const p of state.purchases){
      const k = key(p.date);
      if(!k) continue;
      const m = get(k);
      m.sales += Number(p.price)||0;
      m.cost += Number(p.cost)||0;
    }
    for(const p of state.payments){
      const k = key(p.date);
      if(!k) continue;
      if(isCashReceipt(p)) get(k).collections += Number(p.amount)||0;
    }
    const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    return Array.from(map.entries())
      .sort((a,b)=> b[0].localeCompare(a[0]))
      .map(([k, v]) => {
        const [y, m] = k.split('-');
        return { key:k, label: monthNames[parseInt(m,10)-1] + ' ' + y, ...v };
      });
  }

  // ---------- reports (statistics + income list + modifications, unified page) ----------
  function renderReports(accounts){
    const subTabs = [
      {key:'statements', label:'كشوف الحسابات'},
      {key:'statistics', label:'الإحصائيات'},
      {key:'incomeList', label:'قائمة دخل'},
      {key:'modifications', label:'تقرير التعديلات'},
      {key:'settings', label:'الإعدادات'},
    ];
    const nav = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>التقارير</h2></div>
        <div class="row scroll-row">
          ${subTabs.map(t=>`<button class="btn ${reportsSubTab===t.key?'btn-primary':'btn-ghost'} btn-sm" data-reportsub="${t.key}">${t.label}</button>`).join('')}
        </div>
      </div>`;
    let body = '';
    if(reportsSubTab === 'incomeList') body = renderIncomeList();
    else if(reportsSubTab === 'modifications') body = renderModifications();
    else if(reportsSubTab === 'statements') body = renderStatements(accounts);
    else if(reportsSubTab === 'settings') body = renderSettings();
    else body = renderStatistics(accounts);
    return nav + body;
  }

  function renderStatistics(accounts){
    const totalDue = accounts.reduce((s,c)=>s+Math.max(0,c.balance),0);
    const totalSales = state.purchases.reduce((s,p)=>s+(Number(p.price)||0),0);
    const totalCost = state.purchases.reduce((s,p)=>s+(Number(p.cost)||0),0);
    const totalProfit = state.purchases.reduce((s,p)=>s+(Number(p.profit)||0),0) - adjSum();
    const totalCollected = state.payments.filter(isCashReceipt).reduce((s,p)=>s+(Number(p.amount)||0),0);
    const monthly = computeMonthlyStats();
    return `
      <div class="card">
        <div class="card-head"><h2>إحصائيات عامة</h2></div>
        <div class="cstats">
          <div class="cstat"><b>${money(totalSales)}</b><small>إجمالي المبيعات</small></div>
          <div class="cstat"><b>${money(totalCost)}</b><small>إجمالي التكلفة</small></div>
          <div class="cstat"><b>${money(totalProfit)}</b><small>إجمالي الربح</small></div>
          <div class="cstat"><b>${money(totalCollected)}</b><small>إجمالي المحصَّل (المقبوضات)</small></div>
          <div class="cstat"><b>${money(totalDue)}</b><small>مستحق حالياً (كشوف الحسابات)</small></div>
          <div class="cstat"><b>${accounts.length}</b><small>عدد العملاء</small></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>إحصائيات شهرية</h2></div>
        ${monthly.length ? `
        <div class="table-wrap">
        <table>
          <colgroup><col style="width:120px"><col style="width:auto"><col style="width:auto"><col style="width:auto"></colgroup>
          <thead><tr><th>الشهر</th><th>مبلغ المبيعات</th><th>تكلفة الأجهزة المباعة</th><th>مبلغ التحصيل</th></tr></thead>
          <tbody>
            ${monthly.map(m=>`
              <tr>
                <td class="name-cell">${esc(m.label)}</td>
                <td class="num">${money(m.sales)}</td>
                <td class="num muted">${money(m.cost)}</td>
                <td class="num">${money(m.collections)}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : emptyState('لا توجد بيانات كافية بعد','')}
      </div>
    `;
  }

  // ---------- income list (password-protected profit report) ----------
  let incomeListUnlocked = false;
  let incomeFilter = { customer:'', month:'', year:'' };

  function renderIncomeList(){
    if(!incomeListUnlocked) return renderIncomeListGate();

    let rows = applyTxFilter(state.purchases.slice(), incomeFilter);
    rows.sort((a,b)=>(b.date||"").localeCompare(a.date||""));

    const totalPrice = rows.reduce((s,p)=>s+(Number(p.price)||0),0);
    const totalCost = rows.reduce((s,p)=>s+(Number(p.cost)||0),0);
    const totalProfit = rows.reduce((s,p)=>s+(Number(p.profit)||0),0);
    rows = pgSlice('income', rows);

    const years = txYearsFromDates(state.purchases);
    const customerNames = allCustomerNames();

    return `
      <div class="card">
        <div class="card-head">
          <h2>قائمة دخل</h2>
          <div class="row">
            <button class="btn btn-ghost btn-sm" id="lockIncomeListBtn">قفل الشاشة</button>
          </div>
        </div>
        ${monthYearFilterRow('inc', incomeFilter, customerNames, years, true)}
        <p class="hint">${pgInfo.total} عملية · إجمالي المبيعات ${money(totalPrice)} · إجمالي التكلفة ${money(totalCost)} · إجمالي الربح ${money(totalProfit)}</p>
        ${rows.length===0 ? emptyState('لا توجد بيانات ضمن هذه الفلترة','') : `
        <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width:104px">
            ${colVisible('date')?'<col style="width:92px">':''}
            ${colVisible('product')?'<col style="width:110px">':''}
            ${colVisible('cost')?'<col style="width:90px">':''}
            ${colVisible('profit')?'<col style="width:90px">':''}
            ${colVisible('supplier')?'<col style="width:140px">':''}
          </colgroup>
          <thead><tr><th>العميل</th>${colVisible('date')?'<th>التاريخ</th>':''}${colVisible('product')?'<th>المنتج</th>':''}${colVisible('cost')?'<th>التكلفة</th>':''}${colVisible('profit')?'<th>الربح</th>':''}${colVisible('supplier')?'<th>المورّد</th>':''}</tr></thead>
          <tbody>
            ${rows.map(p=>`
              <tr>
                <td class="name-cell">${esc(p.customerName)}</td>
                ${colVisible('date')?`<td class="muted">${fmtDate(p.date)}</td>`:''}
                ${colVisible('product')?`<td dir="auto" style="white-space:normal">${esc(p.productName)||'—'}</td>`:''}
                ${colVisible('cost')?`<td class="num muted">${money(p.cost)}</td>`:''}
                ${colVisible('profit')?`<td class="num" style="color:var(--brass)">${money(p.profit)}</td>`:''}
                ${colVisible('supplier')?`<td><input type="text" data-supplierinput="${p.id}" value="${esc(p.supplier)||''}" placeholder="—" style="min-width:120px"></td>`:''}
              </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td style="font-weight:800">الإجمالي</td>
            ${colVisible('date')?'<td></td>':''}
            ${colVisible('product')?'<td></td>':''}
            ${colVisible('cost')?`<td class="num" style="font-weight:800">${money(totalCost)}</td>`:''}
            ${colVisible('profit')?`<td class="num" style="font-weight:800;color:var(--brass)">${money(totalProfit)}</td>`:''}
            ${colVisible('supplier')?'<td></td>':''}
          </tr></tfoot>
        </table></div>`}
      </div>
    `;
  }

  function renderIncomeListGate(){
    const hasPassword = !!(state.settings.incomeListPassword);
    return `
      <div class="card">
        <div class="card-head"><h2>قائمة دخل</h2></div>
        <p class="hint">${hasPassword ? 'هذه الشاشة محمية بكلمة مرور إضافية منفصلة عن كلمة مرور الحساب.' : 'لم يتم تعيين كلمة مرور لهذه الشاشة بعد. أنشئ واحدة الآن للمتابعة.'}</p>
        <div class="field" style="max-width:280px;margin-bottom:12px">
          <label>${hasPassword ? 'كلمة المرور' : 'كلمة مرور جديدة'}</label>
          <input type="password" id="incomeListPassInput">
        </div>
        ${!hasPassword ? `<div class="field" style="max-width:280px;margin-bottom:12px"><label>تأكيد كلمة المرور</label><input type="password" id="incomeListPassInput2"></div>` : ''}
        <button class="btn btn-primary" id="incomeListSubmitBtn">${hasPassword ? 'دخول' : 'إنشاء وحفظ'}</button>
        <p class="hint" id="incomeListError" style="color:var(--bad);margin-top:8px"></p>
      </div>
    `;
  }

  let statementsFilter = { customer:'', month:'', year:'' };
  let lastStatementsList = [];
  function renderStatements(accounts){
    let list = accounts.slice();
    const counts = {
      all: accounts.length,
      pending: accounts.filter(c=>c.hasPending).length,
      paid: accounts.filter(c=>c.paidOff).length,
      overdue: accounts.filter(c=>c.overdue).length,
    };
    if(statFilter==='pending') list = list.filter(c=>c.hasPending);
    else if(statFilter==='paid') list = list.filter(c=>c.paidOff);
    else if(statFilter==='overdue') list = list.filter(c=>c.overdue);
    if(statementsFilter.customer) list = list.filter(c=>c.name.toLowerCase().includes(statementsFilter.customer.trim().toLowerCase()));
    if(statementsFilter.month || statementsFilter.year){
      list = list.filter(c=>{
        const txs = state.purchases.concat(state.payments).filter(p=>p.customerName===c.name);
        return txs.some(p=>{
          const d = new Date(p.date);
          if(isNaN(d)) return false;
          if(statementsFilter.year && String(d.getFullYear())!==statementsFilter.year) return false;
          if(statementsFilter.month && String(d.getMonth()+1)!==statementsFilter.month) return false;
          return true;
        });
      });
    }
    const allYears = txYearsFromDates(state.purchases.concat(state.payments));
    const customerNames = allCustomerNames();
    const statusOptions = [
      {key:'all', label:'الكل', count:counts.all},
      {key:'pending', label:'عليهم دفعات', count:counts.pending},
      {key:'paid', label:'مسددون بالكامل', count:counts.paid},
      {key:'overdue', label:'متأخرون', count:counts.overdue},
    ];
    const hasFilter = !!(statementsFilter.customer || statementsFilter.month || statementsFilter.year || statFilter!=='all');
    lastStatementsList = list;
    return `
      <div class="card">
        <div class="card-head">
          <h2>كشوف حسابات العملاء</h2>
          <div class="row">
            <button class="icon-btn" id="shareStatementsBtn" title="مشاركة">🔗 مشاركة</button>
          </div>
        </div>
        <div class="filters-row" style="margin-bottom:16px">
          <div class="field">
            <label>الحالة</label>
            <select id="statStatusFilter">
              ${statusOptions.map(o=>`<option value="${o.key}" ${statFilter===o.key?'selected':''}>${esc(o.label)} (${o.count})</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>العميل</label>
            <input type="text" id="statCustomerFilter" list="statCustomerFilterList" placeholder="كل العملاء" value="${esc(statementsFilter.customer||'')}">
            <datalist id="statCustomerFilterList">${customerNames.map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
          </div>
          <div class="field">
            <label>الشهر</label>
            <select id="statMonthFilter">
              <option value="">كل الشهور</option>
              ${Array.from({length:12},(_,i)=>i+1).map(m=>`<option value="${m}" ${statementsFilter.month===String(m)?'selected':''}>${String(m).padStart(2,'0')}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>السنة</label>
            <select id="statYearFilter">
              <option value="">كل السنوات</option>
              ${allYears.map(y=>`<option value="${y}" ${statementsFilter.year===String(y)?'selected':''}>${y}</option>`).join('')}
            </select>
          </div>
          ${hasFilter ? `<div class="field"><label>&nbsp;</label><button class="btn-clear-blue" id="statClearFilterBtn">إلغاء الفلترة</button></div>` : ''}
        </div>
        <p class="hint">${list.length} عميل ضمن هذه الفلترة</p>
        <p class="hint">اضغط على أي عميل لعرض كل عملياته بالتفصيل.</p>
        ${list.length===0?emptyState('لا يوجد عملاء ضمن هذا الفلتر',''):pgSlice('statements', list).map(c=>customerCard(c)).join('')}
      </div>
      ${datalistNames('customerNamesList')}
    `;
  }
  function customerCard(c){
    let badge='';
    if(c.overdue) badge='<span class="badge badge-warn">متأخر</span>';
    else if(c.paidOff) badge='<span class="badge badge-ok">مسدد بالكامل</span>';
    else if(c.hasPending) badge='<span class="badge badge-muted">عليه دفعات</span>';
    { const lim = creditLimitOf(c.name); if(lim > 0 && c.balance > lim) badge += ' <span class="badge badge-bad">تجاوز الحد</span>'; }
    return `
      <div class="customer-card" data-opencustomer="${esc(c.name)}" style="cursor:pointer">
        <div class="customer-top">
          <div><div class="customer-name">${esc(c.name)} ${badge}</div>
          <div class="customer-phone">${esc(c.phone)||'بدون رقم هاتف'} · ${c.purCount} عملية بيع · ${c.payCount} عملية قبض</div></div>
        </div>
        <div class="cstats">
          <div class="cstat"><b>${money(Math.max(0,c.balance))}</b><small>المبلغ المستحق</small></div>
          <div class="cstat"><b>${fmtDate(c.lastPurchase)}</b><small>تاريخ آخر عملية بيع</small></div>
          <div class="cstat"><b>${fmtDate(c.lastPayment)}</b><small>آخر عملية قبض</small></div>
        </div>
      </div>`;
  }

  function openCustomerDetail(name){
    let matchFirstEnabled = true;
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    document.body.appendChild(wrap);

    const RECONCILE_TOLERANCE = 100;
    function computeReconciliation(){
      const salesAsc = state.purchases.filter(p=>p.customerName===name).sort((a,b)=>(a.date||"").localeCompare(b.date||""));
      const receiptsAsc = state.payments.filter(p=>p.customerName===name).sort((a,b)=>(a.date||"").localeCompare(b.date||""));
      const matchedSaleIds = new Set(), matchedReceiptIds = new Set();
      let diffAdjustment = 0;
      let si = 0, ri = 0;
      while(si < salesAsc.length && ri < receiptsAsc.length){
        let gsi = si, gri = ri;
        const groupSaleIds = [], groupReceiptIds = [];
        let saleSum = 0, paySum = 0;
        while(gsi < salesAsc.length || gri < receiptsAsc.length){
          const closeEnough = groupSaleIds.length && groupReceiptIds.length && Math.abs(saleSum - paySum) <= RECONCILE_TOLERANCE;
          if(closeEnough) break;
          if(gsi < salesAsc.length && (saleSum <= paySum || gri >= receiptsAsc.length)){
            saleSum += Number(salesAsc[gsi].price)||0; groupSaleIds.push(salesAsc[gsi].id); gsi++;
          } else if(gri < receiptsAsc.length){
            paySum += Number(receiptsAsc[gri].amount)||0; groupReceiptIds.push(receiptsAsc[gri].id); gri++;
          } else break;
        }
        if(groupSaleIds.length && groupReceiptIds.length && Math.abs(saleSum - paySum) <= RECONCILE_TOLERANCE){
          groupSaleIds.forEach(id=>matchedSaleIds.add(id));
          groupReceiptIds.forEach(id=>matchedReceiptIds.add(id));
          diffAdjustment += (saleSum - paySum);
          si = gsi; ri = gri;
        } else break;
      }
      return { matchedSaleIds, matchedReceiptIds, diffAdjustment };
    }

    function groupRepeatedReceipts(list){
      const counts = {};
      list.forEach(r=>{ const a = Number(r.amount)||0; if(a>0 && a<=100) counts[a] = (counts[a]||0)+1; });
      const out = [], groups = {};
      list.forEach(r=>{
        const a = Number(r.amount)||0;
        if(a>0 && a<=100 && counts[a]>4){
          let g = groups[a];
          if(!g){ g = groups[a] = { id:'grp_'+a, date:r.date, amount:0, count:0, unit:a, notes:'' }; out.push(g); }
          g.amount += a; g.count++;
          if((r.date||'') > (g.date||'')) g.date = r.date;
        } else out.push(r);
      });
      out.forEach(r=>{ if(r.count) r.notes = `${num(r.unit)} × ${r.count} مرات`; });
      return out;
    }

    function draw(){
      const sales = state.purchases.filter(p=>p.customerName===name).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
      const receipts = state.payments.filter(p=>p.customerName===name).sort((a,b)=>(b.date||"").localeCompare(a.date||""));

      let displaySales = sales, displayReceipts = receipts, countedReceipts = receipts;
      let diffAdjustment = 0;
      if(!matchFirstEnabled){
        const {matchedSaleIds, matchedReceiptIds, diffAdjustment:d} = computeReconciliation();
        let unmatched = receipts;
        if(matchedSaleIds.size || matchedReceiptIds.size){
          displaySales = sales.filter(s=>!matchedSaleIds.has(s.id));
          unmatched = receipts.filter(r=>!matchedReceiptIds.has(r.id));
          diffAdjustment = d;
        }
        countedReceipts = unmatched;
        const shownIds = new Set(unmatched.map(r=>r.id));
        const extras = receipts.slice(0,4).filter(r=>!shownIds.has(r.id))
          .map(r=>Object.assign({}, r, { notes: '(مُسوّاة) ' + (r.notes||'') }));
        displayReceipts = groupRepeatedReceipts(unmatched).concat(extras)
          .sort((a,b)=>(b.date||"").localeCompare(a.date||""));
      }
      let totalSales = displaySales.reduce((s,p)=>s+(Number(p.price)||0),0);
      let totalReceipts = countedReceipts.reduce((s,p)=>s+(Number(p.amount)||0),0);
      if(diffAdjustment > 0.009) totalSales += diffAdjustment;
      else if(diffAdjustment < -0.009) totalReceipts += -diffAdjustment;
      const due = totalSales - totalReceipts;

      const cols = '<colgroup><col style="width:92px"><col style="width:auto"><col style="width:80px"></colgroup>';
      wrap.innerHTML = `
        <div class="modal stmt-modal" style="max-width:720px">
          <div class="card-head"><h3 style="margin:0">${esc(name)}</h3></div>
          <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:10px 0 14px">
            <table>${cols}
              <tbody>
                <tr><td colspan="2" style="color:var(--muted);font-size:14.85px">إجمالي المبيعات</td>
                    <td class="num" style="color:var(--muted);font-size:14.85px">${money(totalSales)}</td></tr>
                <tr><td colspan="2" style="color:var(--muted);font-size:14.85px">إجمالي المقبوضات</td>
                    <td class="num" style="color:var(--muted);font-size:14.85px">${money(totalReceipts)}</td></tr>
                <tr style="border-top:2px solid var(--line)"><td colspan="2" style="font-weight:800;font-size:14.85px">المبلغ المستحق</td>
                    <td class="num" style="font-weight:800;font-size:14.85px">${money(Math.max(0,due))}</td></tr>
              </tbody>
            </table>
          </div>
          <h4 style="margin:16px 0 8px;font-size:14px">المبيعات (${displaySales.length})</h4>
          ${displaySales.length===0 ? '<p class="hint">لا توجد مبيعات</p>' : `
          <div class="table-wrap" style="border:1px solid var(--line)"><table>${cols}
            <thead><tr><th>التاريخ</th><th>المنتج</th><th>السعر</th></tr></thead>
            <tbody>${displaySales.map(s=>`
              <tr><td class="muted">${fmtDate(s.date)}</td><td>${esc(s.productName)||'—'}</td>
              <td class="num">${money(s.price)}</td></tr>`).join('')}</tbody>
          </table></div>`}
          <h4 style="margin:20px 0 8px;font-size:14px">المقبوضات (${displayReceipts.length})</h4>
          ${displayReceipts.length===0 ? '<p class="hint">لا توجد مقبوضات</p>' : `
          <div class="table-wrap" style="border:1px solid var(--line)"><table>${cols}
            <thead><tr><th>التاريخ</th><th>ملاحظات</th><th>المبلغ</th></tr></thead>
            <tbody>${displayReceipts.map(r=>`
              <tr><td class="muted">${fmtDate(r.date)}</td>
              <td class="muted" style="white-space:normal">${esc(r.notes)||'—'}</td>
              <td class="num">${money(r.amount)}</td></tr>`).join('')}</tbody>
          </table></div>`}
          <div class="modal-actions share-hide" style="justify-content:space-between">
            <div class="row">
              <label class="doubt-toggle" style="font-size:11.52px"><input type="checkbox" id="matchFirstToggle" style="transform:scale(.96)" ${matchFirstEnabled?'checked':''}> كل العمليات</label>
            </div>
            <button class="btn btn-primary" id="closeDetailBtn" style="padding:5.52px 9.84px;font-size:8.57px;border-radius:5.52px;min-width:58.8px;text-align:center">إغلاق</button>
          </div>
          <div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:flex-start;gap:8px;white-space:nowrap;overflow:hidden;font-size:11.5px;color:var(--muted)">
            <b style="color:var(--navy)">مكة للهواتف الذكية</b>
            <span style="background:#25D366;color:#fff;border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:10px">✆</span>
            <span dir="ltr">00970568992022</span>
          </div>
        </div>`;

      wrap.querySelector("#matchFirstToggle").addEventListener("change",(e)=>{ matchFirstEnabled = e.target.checked; draw(); });
      
      wrap.querySelector("#closeDetailBtn").addEventListener("click", ()=>document.body.removeChild(wrap));
    }

    draw();
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
  }

  // ---------- modifications report ----------
  // field labels per entity, for readable diffs
  const FIELD_LABELS = {
    customer: { name:'الاسم', phone:'الهاتف', address:'العنوان', notes:'ملاحظات', creditLimit:'حد الدين' },
    sale: { customerName:'العميل', date:'تاريخ البيع', productName:'المنتج', price:'السعر', cost:'التكلفة', profit:'الربح', supplier:'المورّد', notes:'ملاحظات' },
    receipt: { customerName:'العميل', date:'تاريخ القبض', amount:'المبلغ', notes:'ملاحظات' },
  };
  const ENTITY_LABELS = { customer:'عميل', sale:'عملية بيع', receipt:'عملية قبض' };
  const ACTION_LABELS = { create:'إضافة', update:'تعديل', delete:'حذف' };
  const ACTION_BADGE = { create:'badge-ok', update:'badge-warn', delete:'badge-bad' };

  function fmtFieldValue(v){
    if(v === null || v === undefined || v === '') return '—';
    if(typeof v === 'boolean') return v ? 'نعم' : 'لا';
    return esc(String(v));
  }

  function renderHistoryDiff(entry){
    // full, complete statement of every field for every action type (إضافة / حذف / تعديل) —
    // nothing is filtered out, so the archive always shows the whole record.
    const labels = FIELD_LABELS[entry.entityType] || {};
    const nameKey = entry.entityType === 'customer' ? 'name' : 'customerName';
    const nameChanged = entry.action === 'update' && JSON.stringify(entry.before ? entry.before[nameKey] : null) !== JSON.stringify(entry.after ? entry.after[nameKey] : null);
    const keys = Object.keys(labels).filter(k => k !== nameKey || nameChanged);
    if(entry.action === 'create'){
      return keys.map(k => `<div class="diff-row"><span class="diff-label">${labels[k]}:</span> <span class="diff-new">${fmtFieldValue(entry.after ? entry.after[k] : null)}</span></div>`).join('');
    }
    if(entry.action === 'delete'){
      return keys.map(k => `<div class="diff-row"><span class="diff-label">${labels[k]}:</span> <span class="diff-old" style="text-decoration:line-through">${fmtFieldValue(entry.before ? entry.before[k] : null)}</span></div>`).join('');
    }
    // update: show every field — the ones that changed highlighted before/after, the rest shown as-is
    return keys.map(k => {
      const before = entry.before ? entry.before[k] : null;
      const after = entry.after ? entry.after[k] : null;
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      if(changed){
        return `<div class="diff-row"><span class="diff-label">${labels[k]}:</span> <span class="diff-old">${fmtFieldValue(before)}</span> ← <span class="diff-new">${fmtFieldValue(after)}</span></div>`;
      }
      return `<div class="diff-row"><span class="diff-label">${labels[k]}:</span> <span class="muted">${fmtFieldValue(after)}</span></div>`;
    }).join('');
  }

  function historyCustomerName(h){
    const rec = h.after || h.before;
    if(!rec) return '—';
    return rec.customerName || rec.name || '—';
  }

  let historyFilter = { customer:'', month:'', year:'' };
  function renderModifications(){
    let rows = (state.history||[]).slice().sort((a,b)=>(b.at||"").localeCompare(a.at||""));
    if(historyFilter.customer) rows = rows.filter(h=>historyCustomerName(h)===historyFilter.customer);
    if(historyFilter.year) rows = rows.filter(h=>{ const d=new Date(h.at); return !isNaN(d) && String(d.getFullYear())===historyFilter.year; });
    if(historyFilter.month) rows = rows.filter(h=>{ const d=new Date(h.at); return !isNaN(d) && String(d.getMonth()+1)===historyFilter.month; });
    rows = pgSlice('history', rows);
    const allDates = (state.history||[]).map(h=>({date:h.at}));
    const years = txYearsFromDates(allDates);
    const customerNames = allCustomerNames();
    return `
      <div class="card">
        <div class="card-head"><h2>أرشيف التعديلات</h2></div>
        <p class="hint">سجل كامل لكل إضافة أو تعديل أو حذف على العملاء والمبيعات والمقبوضات، مع بيان القيمة قبل التعديل وبعده.</p>
        ${monthYearFilterRow('hist', historyFilter, customerNames, years, true)}
        <p class="hint">${pgInfo.total} حركة ضمن هذه الفلترة</p>
        ${rows.length===0?emptyState('لا يوجد سجل تعديلات ضمن هذه الفلترة',''):`
        <p class="hint" style="margin-bottom:8px">اسحب أي صف يميناً/يساراً لقراءة كامل التفاصيل عند تجاوزها ثلاثة أسطر.</p>
        <div class="table-wrap">
        <table style="table-layout:auto;min-width:640px">
          <colgroup><col style="width:130px"><col style="width:110px"><col style="width:90px"><col style="width:80px"><col style="min-width:260px"></colgroup>
          <thead><tr><th>الوقت</th><th>العميل</th><th>النوع</th><th>الإجراء</th><th>التفاصيل (كل البيانات)</th></tr></thead>
          <tbody>
            ${rows.map(h=>`
              <tr>
                <td class="muted" style="font-size:12px;white-space:nowrap;line-height:1.7">${fmtDate(h.at)}<br>${fmtTimeOnly(h.at)}</td>
                <td class="name-cell">${esc(historyCustomerName(h))}</td>
                <td>${ENTITY_LABELS[h.entityType]||h.entityType}</td>
                <td><span class="badge ${ACTION_BADGE[h.action]||'badge-muted'}">${ACTION_LABELS[h.action]||h.action}</span></td>
                <td style="white-space:normal"><div class="diff-box">${renderHistoryDiff(h)}</div></td>
              </tr>`).join('')}
          </tbody>
        </table></div>`}
      </div>
    `;
  }

  // ---------- settings ----------
  function renderSettings(){
    return `
      <div class="card">
        <div class="card-head"><h2>الإعدادات</h2></div>
        <div class="grid2">
          <div class="field">
            <label>عدد الأيام لاعتبار العميل متأخراً</label>
            <input type="number" id="overdueDaysInput" value="${state.settings.overdueDays}" min="1">
            <div class="hint">إذا مرّت هذه المدة دون أي حركة وكان على العميل مبلغ مستحق، يُصنَّف كـ"متأخر".</div>
          </div>
          <div class="field"><label>رمز العملة</label><input type="text" id="currencyInput" value="${esc(state.settings.currency)}" maxlength="4"></div>
          <div class="field">
            <label>إظهار رمز العملة بجانب المبالغ</label>
            <select id="showCurrencyInput">
              <option value="yes" ${state.settings.showCurrency!==false?'selected':''}>إظهار الرمز (مثال: 750 ₪)</option>
              <option value="no" ${state.settings.showCurrency===false?'selected':''}>المبلغ فقط بدون رمز (مثال: 750)</option>
            </select>
          </div>
        </div>
        <div class="row" style="margin-top:16px"><button class="btn btn-primary" id="saveSettingsBtn">حفظ الإعدادات</button></div>
      </div>
      ${renderControlsCard()}
      ${renderColumnsSettingsCard()}
      <div class="card">
        <div class="card-head"><h2>الحساب</h2></div>
        <p class="hint">مسجّل دخول حالياً بالبريد: <b style="color:var(--ink)">${esc(fbAuth.currentUser?fbAuth.currentUser.email:'—')}</b></p>
        <p class="hint">بياناتك متزامنة تلقائياً مع هذا الحساب — يمكنك تسجيل الدخول به من أي جهاز أو متصفح وستجد نفس البيانات فوراً.</p>
        <div class="row">
          <button class="btn btn-ghost" id="resetPassBtn">إرسال رابط تغيير كلمة المرور لبريدي</button>
          <button class="btn btn-ghost" id="signOutBtn">تسجيل الخروج</button>          <button class="btn btn-ghost" id="linkGoogleBtn">ربط حساب Google بهذا الحساب</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>المصادقة الثنائية (Authenticator)</h2></div>
        <p class="hint">${state.settings.totpEnabled ? 'مفعّلة حالياً — سيُطلب رمز من تطبيق المصادقة (مثل Google Authenticator أو Microsoft Authenticator أو Authy) في كل مرة يتم فيها تسجيل الدخول.' : 'غير مفعّلة — فعّلها لإضافة طبقة حماية إضافية عند تسجيل الدخول باستخدام تطبيق مصادقة على هاتفك.'}</p>
        <div class="row">
          ${state.settings.totpEnabled
            ? '<button class="btn btn-ghost" id="disableTotpBtn">تعطيل المصادقة الثنائية</button>'
            : '<button class="btn btn-primary" id="enableTotpBtn">تفعيل المصادقة الثنائية</button>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>قائمة دخل</h2></div>
        <p class="hint">${state.settings.incomeListPassword ? 'محمية حالياً بكلمة مرور.' : 'لم تُعيَّن كلمة مرور بعد — سيُطلب منك إنشاء واحدة عند أول دخول للشاشة.'}</p>
        ${state.settings.incomeListPassword ? `<div class="row"><button class="btn btn-ghost" id="resetIncomeListPassBtn">إعادة تعيين كلمة المرور</button></div>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><h2>نسخ احتياطي</h2></div>
        <p class="hint">تنزيل نسخة من كل بياناتك كملف JSON. ننصح بأخذ نسخة بشكل دوري كضمان إضافي، أو لنقل البيانات لجهاز آخر.</p>
        <div class="row"><button class="btn btn-ghost" id="exportBtn">تنزيل نسخة احتياطية</button></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>استيراد ذمم دفتر ٢٠٢٤ (تقسيط)</h2></div>
        <p class="hint">استيراد لمرة واحدة لجميع العملاء الذين بقي عليهم رصيد مستحق من صفحة "تقسيط" في ملف إكسل ٢٠٢٤
        (295 حركة تخص 37 عميلاً، بإجمالي رصيد مستحق قدره تقريباً 68,999).</p>
        <div class="row">
          <button class="btn btn-primary" id="importTaqseetBtn" ${state.settings.importedTaqseet2024?'disabled':''}>
            ${state.settings.importedTaqseet2024?'تم الاستيراد مسبقاً ✓':'استيراد الآن'}
          </button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>استيراد الذمم القديمة (ما قبل 2023)</h2></div>
        <p class="hint">استيراد لمرة واحدة لجميع الحركات القديمة من ملف "الذمم القديمة" (سنوات 2018–2023).
        سيُضاف لكل اسم عميل في هذا الملف عبارة "- ما قبل 2023" لتمييزه عن أي عميل بنفس الاسم في الدفاتر الأخرى، حتى لو تشابه الاسم.
        (336 حركة تخص 54 عميلاً).</p>
        <div class="row">
          <button class="btn btn-primary" id="importOldDebtsBtn" ${state.settings.importedOldDebtsPre2023?'disabled':''}>
            ${state.settings.importedOldDebtsPre2023?'تم الاستيراد مسبقاً ✓':'استيراد الآن'}
          </button>
        </div>
      </div>
    `;
  }

  // ---------- Authenticator (TOTP) enable / disable ----------
  function openTotpSetupModal(){
    const secret = generateTotpSecret();
    const email = fbAuth.currentUser ? fbAuth.currentUser.email : '';
    const issuer = 'مكة للهواتف الذكية';
    const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = `
      <div class="modal" style="max-width:420px">
        <h3>تفعيل المصادقة الثنائية</h3>
        <p class="hint">افتح تطبيق المصادقة على هاتفك (Google Authenticator، Microsoft Authenticator، أو Authy) واختر "إضافة حساب" ثم "إدخال المفتاح يدوياً"، وأدخل المفتاح التالي:</p>
        <div class="field" style="margin-bottom:10px">
          <label>المفتاح السري</label>
          <input type="text" readonly value="${secret}" style="font-family:monospace;letter-spacing:1px" onclick="this.select()">
        </div>
        <p class="hint" style="word-break:break-all;font-size:11px">${esc(otpauth)}</p>
        <div class="field" style="max-width:220px;margin:14px 0">
          <label>أدخل الرمز المكوّن من ٦ أرقام لتأكيد التفعيل</label>
          <input type="text" id="totpSetupCode" maxlength="6" inputmode="numeric" dir="ltr" style="text-align:center;letter-spacing:4px;font-size:18px">
        </div>
        <p class="hint" id="totpSetupError" style="color:var(--bad);min-height:16px"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancelBtn">إلغاء</button>
          <button class="btn btn-primary" id="confirmTotpBtn">تفعيل</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
    document.getElementById("cancelBtn").addEventListener("click", ()=>document.body.removeChild(wrap));
    document.getElementById("confirmTotpBtn").addEventListener("click", async ()=>{
      const code = document.getElementById("totpSetupCode").value.trim();
      const errEl = document.getElementById("totpSetupError");
      if(!/^\d{6}$/.test(code)){ errEl.textContent = "أدخل رمزاً من ٦ أرقام"; return; }
      const ok = await verifyTotp(secret, code);
      if(!ok){ errEl.textContent = "الرمز غير صحيح، تأكد من ضبط الوقت في جهازك وحاول مرة أخرى"; return; }
      state.settings.totpEnabled = true;
      state.settings.totpSecret = secret;
      saveData();
      document.body.removeChild(wrap);
      showToast("تم تفعيل المصادقة الثنائية");
      render();
    });
  }

  function openTotpDisableModal(){
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = `
      <div class="modal" style="max-width:360px">
        <h3>تعطيل المصادقة الثنائية</h3>
        <p class="hint">لتأكيد التعطيل، أدخل الرمز الحالي من تطبيق المصادقة.</p>
        <div class="field" style="max-width:220px;margin:14px 0">
          <label>رمز التحقق</label>
          <input type="text" id="totpDisableCode" maxlength="6" inputmode="numeric" dir="ltr" style="text-align:center;letter-spacing:4px;font-size:18px">
        </div>
        <p class="hint" id="totpDisableError" style="color:var(--bad);min-height:16px"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancelBtn">إلغاء</button>
          <button class="btn btn-primary" id="confirmDisableBtn">تعطيل</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) document.body.removeChild(wrap); });
    document.getElementById("cancelBtn").addEventListener("click", ()=>document.body.removeChild(wrap));
    document.getElementById("confirmDisableBtn").addEventListener("click", async ()=>{
      const code = document.getElementById("totpDisableCode").value.trim();
      const errEl = document.getElementById("totpDisableError");
      if(!/^\d{6}$/.test(code)){ errEl.textContent = "أدخل رمزاً من ٦ أرقام"; return; }
      const ok = await verifyTotp(state.settings.totpSecret, code);
      if(!ok){ errEl.textContent = "الرمز غير صحيح"; return; }
      delete state.settings.totpEnabled;
      delete state.settings.totpSecret;
      saveData();
      document.body.removeChild(wrap);
      showToast("تم تعطيل المصادقة الثنائية");
      render();
    });
  }

  function exportBackup(){
    const blob = new Blob([JSON.stringify(state,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href=url; a.download="نسخة-احتياطية-الدفتر.json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast("تم تنزيل النسخة الاحتياطية");
  }

  let _seedP = null;
  function loadSeed(){
    if(typeof SEED_TAQSEET_2024 !== 'undefined') return Promise.resolve();
    return _seedP = _seedP || new Promise((res, rej)=>{
      const s = document.createElement('script'); s.src = 'seed.js'; s.onload = res;
      s.onerror = ()=>{ _seedP = null; showToast('تعذّر تحميل ملف البيانات seed.js'); rej(); };
      document.head.appendChild(s);
    });
  }
  async function importTaqseet2024(){ if(state.settings.importedTaqseet2024) return; try{ await loadSeed(); }catch(e){ return; }
    if(state.settings.importedTaqseet2024) return;
    const now = new Date().toISOString();
    for(const row of SEED_TAQSEET_2024){
      ensureCustomerExists(row.buyerName, row.buyerPhone);
      if(Number(row.debit) > 0){
        state.purchases.push({ id: uid('pur'), customerName: row.buyerName, date: row.date,
          productName: row.deviceType||"", price: Number(row.debit)||0, cost: Number(row.cost)||0,
          profit: Number(row.profit)||0, supplier: row.supplier||"", createdAt: now, updatedAt: now });
      }
      if(Number(row.credit) > 0){
        state.payments.push({ id: uid('pay'), customerName: row.buyerName, date: row.date,
          amount: Number(row.credit)||0, notes: row.deviceType||"", createdAt: now, updatedAt: now });
      }
    }
    state.settings.importedTaqseet2024 = true;
    saveData(); showToast(`تم استيراد 295 حركة`); render();
  }

  async function importOldDebtsPre2023(){ if(state.settings.importedOldDebtsPre2023) return; try{ await loadSeed(); }catch(e){ return; }
    if(state.settings.importedOldDebtsPre2023) return;
    const now = new Date().toISOString();
    for(const row of SEED_OLD_DEBTS_PRE2023){
      ensureCustomerExists(row.buyerName, row.buyerPhone);
      if(Number(row.debit) > 0){
        state.purchases.push({ id: uid('pur'), customerName: row.buyerName, date: row.date,
          productName: row.deviceType||"", price: Number(row.debit)||0, cost: Number(row.cost)||0,
          profit: Number(row.profit)||0, supplier: row.supplier||"", createdAt: now, updatedAt: now });
      }
      if(Number(row.credit) > 0){
        state.payments.push({ id: uid('pay'), customerName: row.buyerName, date: row.date,
          amount: Number(row.credit)||0, notes: row.deviceType||"", createdAt: now, updatedAt: now });
      }
    }
    state.settings.importedOldDebtsPre2023 = true;
    saveData(); showToast(`تم استيراد 336 حركة`); render();
  }

  /*CTRL_START*/
  // ---------- internal controls: password hashing, period lock, staff mode ----------
  function sha256(str){
    const bin = unescape(encodeURIComponent(str));
    const K = [], H = []; let p = 2, c = 0;
    while(c < 64){ let ok = true; for(let i=2;i*i<=p;i++){ if(p%i===0){ ok=false; break; } }
      if(ok){ if(c<8) H[c] = (Math.pow(p,.5)%1)*4294967296|0; K[c] = (Math.pow(p,1/3)%1)*4294967296|0; c++; } p++; }
    const bits = bin.length*8; let m = bin + '\x80'; while(m.length%64 !== 56) m += '\0';
    const words = []; for(let i=0;i<m.length;i++) words[i>>2] = (words[i>>2]|0) | (m.charCodeAt(i) << (24-(i%4)*8));
    words.push(0, bits);
    let Hs = H.slice();
    for(let j=0;j<words.length;j+=16){
      const W = words.slice(j,j+16);
      for(let i=16;i<64;i++){ const a=W[i-15], d=W[i-2];
        W[i] = (W[i-16] + (((a>>>7)|(a<<25))^((a>>>18)|(a<<14))^(a>>>3)) + W[i-7] + (((d>>>17)|(d<<15))^((d>>>19)|(d<<13))^(d>>>10)))|0; }
      let [a,b,c2,d,e,f2,g,h] = Hs;
      for(let i=0;i<64;i++){
        const S1 = ((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
        const t1 = (h + S1 + ((e&f2)^(~e&g)) + K[i] + W[i])|0;
        const S0 = ((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
        const t2 = (S0 + ((a&b)^(a&c2)^(b&c2)))|0;
        h=g; g=f2; f2=e; e=(d+t1)|0; d=c2; c2=b; b=a; a=(t1+t2)|0; }
      Hs = [Hs[0]+a|0,Hs[1]+b|0,Hs[2]+c2|0,Hs[3]+d|0,Hs[4]+e|0,Hs[5]+f2|0,Hs[6]+g|0,Hs[7]+h|0];
    }
    return Hs.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
  }
  function hashPw(pw){ return 'h1:' + sha256('mkp-income|' + pw); }
  function checkIncomePw(pw){
    const s = state.settings.incomeListPassword || '';
    if(s.startsWith('h1:')) return s === hashPw(pw);
    if(pw === s){ state.settings.incomeListPassword = hashPw(pw); saveData(); return true; } // upgrade old plain-text password
    return false;
  }
  function isLocked(d){ const L = state.settings.lockedBefore; return !!(L && d && String(d).slice(0,10) <= L); }
  const isStaff = () => localStorage.getItem('staffMode') === '1';
  function exitStaffMode(){
    const pw = prompt('أدخل كلمة مرور حساب المالك للخروج من وضع الموظف'); if(!pw) return;
    const u = fbAuth.currentUser;
    u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, pw))
      .then(()=>{ localStorage.removeItem('staffMode'); showToast('تم الخروج من وضع الموظف'); render(); })
      .catch(()=>showToast('كلمة المرور غير صحيحة'));
  }
  function renderControlsCard(){
    return `
      <div class="card">
        <div class="card-head"><h2>الضبط الداخلي</h2></div>
        <div class="field" style="max-width:300px;margin-bottom:12px">
          <label>إغلاق الفترات: لا إضافة/تعديل/حذف لأي حركة بتاريخ حتى هذا اليوم (شامل)</label>
          <input type="date" id="lockedBeforeInput" dir="ltr" value="${esc(state.settings.lockedBefore||'')}">
        </div>
        <div class="row">
          <div class="field" style="min-width:230px"><label>حد دين افتراضي لكل العملاء (فارغ = بلا حد)</label><input type="number" id="defaultLimitInput" value="${state.settings.defaultCreditLimit||''}"></div>
          <button class="btn btn-primary" id="saveLockBtn">حفظ</button>
          <button class="btn btn-ghost" id="staffModeBtn">تفعيل وضع الموظف على هذا الجهاز</button>
        </div>
        <p class="hint">وضع الموظف يخفي التكلفة والربح والمورّد والتقارير والمالية وأزرار الحذف، ولا يُخرَج منه إلا بكلمة مرور حساب المالك.</p>
      </div>`;
  }
  /*CTRL_END*/
  // ---------- receipts kinds: payment (cash) | discount | return ----------
  const isCashReceipt = p => !p.kind || p.kind === 'payment';
  // profit effect of a non-cash credit: discount = its amount unless overridden; return = the profit of the returned item (entered by user)
  function profitAdjOf(p){
    if(isCashReceipt(p)) return 0;
    if(p.profitAdj !== null && p.profitAdj !== undefined && p.profitAdj !== '') return Number(p.profitAdj)||0;
    return p.kind === 'discount' ? (Number(p.amount)||0) : 0;
  }
  const adjSum = () => state.payments.reduce((s,p)=>s+profitAdjOf(p),0);
  // ---------- returns -> stock link ----------
  // Links (or unlinks) a return receipt to an inventory device: linked device goes back to stock ('in'),
  // unlinking / re-linking / deleting the receipt restores it to 'sold' against its original sale.
  function applyReturnLink(rec, newItemId){
    const inv = state.inventory || [];
    if(rec.returnItemId && rec.returnItemId !== newItemId){
      const old = inv.find(i=>i.id===rec.returnItemId);
      if(old && old.status === 'in' && old.returnedPurchaseId){ old.status = 'sold'; old.purchaseId = old.returnedPurchaseId; delete old.returnedPurchaseId; }
    }
    if(newItemId && newItemId !== rec.returnItemId){
      const it = inv.find(i=>i.id===newItemId);
      if(it && it.status === 'sold'){ it.returnedPurchaseId = it.purchaseId || null; delete it.purchaseId; it.status = 'in'; }
    }
    rec.returnItemId = newItemId || null;
  }
  // ---------- credit limits ----------
  function creditLimitOf(name){
    const c = findCustomer(name);
    const own = c && Number(c.creditLimit) > 0 ? Number(c.creditLimit) : 0;
    return own || Number(state.settings.defaultCreditLimit) || 0;
  }
  function balanceOf(name){
    return state.purchases.filter(p=>p.customerName===name).reduce((s,p)=>s+(Number(p.price)||0),0)
         - state.payments.filter(p=>p.customerName===name).reduce((s,p)=>s+(Number(p.amount)||0),0);
  }
  // ---------- pagination: show 100 rows at a time with a "show more" button ----------
  const PG_SIZE = 100;
  const pgLimits = {};
  let pgInfo = null, pgLastSig = '';
  function pgSlice(key, arr){
    const lim = pgLimits[key] || PG_SIZE;
    pgInfo = { key, total: arr.length, shown: Math.min(lim, arr.length) };
    return arr.slice(0, lim);
  }
  // called at the start of every render: reset the paging when tab / filters / search / sort changed
  function pagingSync(){
    const sig = JSON.stringify([currentTab, reportsSubTab, search, purchasesFilter, paymentsFilter, incomeFilter, historyFilter, statementsFilter, statFilter, sortDesc]);
    if(sig !== pgLastSig){ pgLastSig = sig; Object.keys(pgLimits).forEach(k=>delete pgLimits[k]); }
    pgInfo = null;
  }
  // called at the end of every render: add the "show more" button under the (truncated) list
  function pagingButton(){
    if(!pgInfo || pgInfo.total <= pgInfo.shown) return;
    const host = document.getElementById('tabContent'); if(!host) return;
    const cards = host.querySelectorAll('.customer-card');
    const anchor = host.querySelector('.table-wrap') || (cards.length ? cards[cards.length-1] : null);
    if(!anchor) return;
    const key = pgInfo.key, shown = pgInfo.shown, total = pgInfo.total;
    const d = document.createElement('div');
    d.style.cssText = 'text-align:center;margin:12px 0';
    d.innerHTML = '<p class="hint">يظهر ' + shown + ' من ' + total + '</p><button class="btn btn-ghost" id="pgMoreBtn">عرض ' + PG_SIZE + ' إضافية</button>';
    anchor.after(d);
    d.querySelector('#pgMoreBtn').addEventListener('click', ()=>{ pgLimits[key] = (pgLimits[key] || PG_SIZE) + PG_SIZE; render(); });
  }
  // ---------- المالية: customers / sales / receipts live inside the Finance page ----------
  const FIN_TABS = ['customers','purchases','payments','finance'];
  const FIN_NAV = [['customers','العملاء'],['purchases','المبيعات'],['payments','المقبوضات'],['accounts','الصناديق والبنوك'],['inv','المخزون والموردون'],['plans','الأقساط'],['chq','الشيكات'],['rep','التقارير المالية']];
  function finNav(){
    const act = currentTab === 'finance' ? window.Ext.getSub() : currentTab;
    return '<div class="card" style="margin-bottom:16px"><div class="row scroll-row">' +
      FIN_NAV.map(t=>'<button class="btn ' + (act===t[0]?'btn-primary':'btn-ghost') + ' btn-sm" data-fin="' + t[0] + '">' + t[1] + '</button>').join('') + '</div></div>';
  }
  function finGo(k){
    if(k==='customers' || k==='purchases' || k==='payments') currentTab = k;
    else { currentTab = 'finance'; window.Ext.setSub(k); }
    Object.keys(pgLimits).forEach(x=>delete pgLimits[x]);
    render();
  }

  // ---------- share by double tap inside an ALREADY-open customer window (not on the page, not on cards) ----------
  let _preOpen = false;
  document.addEventListener('click', ()=>{ _preOpen = !!document.querySelector('.overlay #matchFirstToggle'); }, true);
  let _lastTap = { t:0, x:0, y:0, pre:false };
  document.addEventListener('click', (e)=>{
    const now = Date.now();
    const dbl = (now - _lastTap.t) < 450 && Math.abs(e.clientX - _lastTap.x) < 40 && Math.abs(e.clientY - _lastTap.y) < 40;
    const ok = dbl && _lastTap.pre;   // the window was already open at the first tap (double tap on a card only opens it)
    _lastTap = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY, pre: _preOpen };
    if(!ok) return;
    if(e.target.closest && e.target.closest('input,select,textarea,button,a,label')) return;
    const detail = document.querySelector('.overlay #matchFirstToggle');
    if(!detail) return;
    const modal = detail.closest('.modal'), nm = modal.querySelector('h3').textContent.trim();
    shareElementAsImage(nm, modal, nm);
  });
  function emptyState(title, sub){ return `<div class="empty"><b>${esc(title)}</b>${sub?`<div>${esc(sub)}</div>`:''}</div>`; }

  // ---------- events ----------
  function bindEvents(accounts){    /*dbl-edit*/
    {
      const byDate = (a,b)=> sortDesc ? (b.date||"").localeCompare(a.date||"") : (a.date||"").localeCompare(b.date||"");
      let openers = null;
      if(currentTab==="purchases"){
        const rows = applyTxFilter(state.purchases.slice(), purchasesFilter).sort(byDate);
        openers = rows.map(r=>()=>openPurchaseModal(r.id));
      } else if(currentTab==="payments"){
        const rows = applyTxFilter(state.payments.slice(), paymentsFilter).sort(byDate);
        openers = rows.map(r=>()=>openPaymentModal(r.id));
      } else if(currentTab==="reports" && reportsSubTab==="modifications"){
        let rows = (state.history||[]).slice().sort((a,b)=>(b.at||"").localeCompare(a.at||""));
        if(historyFilter.customer) rows = rows.filter(h=>historyCustomerName(h)===historyFilter.customer);
        if(historyFilter.year) rows = rows.filter(h=>{ const d=new Date(h.at); return !isNaN(d) && String(d.getFullYear())===historyFilter.year; });
        if(historyFilter.month) rows = rows.filter(h=>{ const d=new Date(h.at); return !isNaN(d) && String(d.getMonth()+1)===historyFilter.month; });
        openers = rows.map(h=>()=>{
          const rec = h.after || h.before;
          const id = rec && rec.id;
          const src = h.entityType==='sale' ? state.purchases : h.entityType==='receipt' ? state.payments : state.customers;
          if(!id || !src.some(x=>x.id===id)){ showToast("هذا السجل محذوف ولم يعد موجوداً"); return; }
          if(h.entityType==='sale') openPurchaseModal(id);
          else if(h.entityType==='receipt') openPaymentModal(id);
          else openCustomerModal(id);
        });
      }
      if(openers){
        document.querySelectorAll("#tabContent tbody tr").forEach((tr,i)=>tr.addEventListener("dblclick", ()=>{ if(openers[i]) openers[i](); }));
      }
    }
    
    if(currentTab==="customers"){
      document.getElementById("searchCustomers").addEventListener("input",(e)=>{ search.customers=e.target.value; render(); });
      document.querySelectorAll("[data-editcust]").forEach(b=>b.addEventListener("click",()=>openCustomerModal(b.dataset.editcust)));
      document.querySelectorAll("[data-delcust]").forEach(b=>b.addEventListener("click",()=>deleteCustomer(b.dataset.delcust)));
    } else if(currentTab==="purchases"){
      document.getElementById("sortBtn").addEventListener("click", ()=>{ sortDesc=!sortDesc; render(); });
      attachTxFilterListeners('pur', purchasesFilter, true);
      document.querySelectorAll("[data-editpur]").forEach(b=>b.addEventListener("click",()=>openPurchaseModal(b.dataset.editpur)));
      document.querySelectorAll("[data-delpur]").forEach(b=>b.addEventListener("click",()=>{
        if(!confirm("هل تريد حذف عملية البيع هذه؟")) return;
        { const r0 = state.purchases.find(p=>p.id===b.dataset.delpur); if(r0 && isLocked(r0.date)){ showToast("هذه الفترة مقفلة ولا يمكن تعديل حركاتها"); return; } }
        const rec = state.purchases.find(p=>p.id===b.dataset.delpur);
        state.purchases = state.purchases.filter(p=>p.id!==b.dataset.delpur);
        if(rec) logHistory('sale', 'delete', Object.assign({}, rec), null);
        saveData(); showToast("تم الحذف"); render();
      }));
    } else if(currentTab==="payments"){
      document.getElementById("sortBtn").addEventListener("click", ()=>{ sortDesc=!sortDesc; render(); });
      attachTxFilterListeners('pay', paymentsFilter, true);
      document.querySelectorAll("[data-editpay]").forEach(b=>b.addEventListener("click",()=>openPaymentModal(b.dataset.editpay)));
      document.querySelectorAll("[data-delpay]").forEach(b=>b.addEventListener("click",()=>{
        if(!confirm("هل تريد حذف عملية القبض هذه؟")) return;
        { const r0 = state.payments.find(p=>p.id===b.dataset.delpay); if(r0 && isLocked(r0.date)){ showToast("هذه الفترة مقفلة ولا يمكن تعديل حركاتها"); return; } }
        const rec = state.payments.find(p=>p.id===b.dataset.delpay);
        if(rec && rec.returnItemId) applyReturnLink(rec, null);
        state.payments = state.payments.filter(p=>p.id!==b.dataset.delpay);
        if(rec) logHistory('receipt', 'delete', Object.assign({}, rec), null);
        saveData(); showToast("تم الحذف"); render();
      }));
    } else if(currentTab==="finance"){ window.Ext.bind();
    } else if(currentTab==="reports"){
      document.querySelectorAll("[data-reportsub]").forEach(b=>b.addEventListener("click", ()=>{ reportsSubTab=b.dataset.reportsub; render(); }));
      if(reportsSubTab==="statements"){
        const statStatus = document.getElementById("statStatusFilter");
        if(statStatus) statStatus.addEventListener("change",(e)=>{ statFilter = e.target.value; render(); });
        const statCust = document.getElementById("statCustomerFilter");
        if(statCust) statCust.addEventListener("input",(e)=>{ statementsFilter.customer = e.target.value; render(); });
        const statMonth = document.getElementById("statMonthFilter");
        if(statMonth) statMonth.addEventListener("change",(e)=>{ statementsFilter.month = e.target.value; render(); });
        const statYear = document.getElementById("statYearFilter");
        if(statYear) statYear.addEventListener("change",(e)=>{ statementsFilter.year = e.target.value; render(); });
        const statClear = document.getElementById("statClearFilterBtn");
        if(statClear) statClear.addEventListener("click", ()=>{ statFilter='all'; statementsFilter.customer=''; statementsFilter.month=''; statementsFilter.year=''; render(); });
        const shareStatBtn = document.getElementById("shareStatementsBtn");
        if(shareStatBtn) shareStatBtn.addEventListener("click", ()=>{
          const lines = lastStatementsList.map(c=>`${c.name}: مستحق ${money(Math.max(0,c.balance))}`);
          const text = `كشوف حسابات العملاء\n${lines.join('\n')}`;
          shareText('كشوف حسابات العملاء', text);
        });
        document.querySelectorAll("[data-opencustomer]").forEach(card=>card.addEventListener("click",()=>{
          openCustomerDetail(card.dataset.opencustomer);
        }));
      } else if(reportsSubTab==="incomeList"){
        if(incomeListUnlocked){
          document.getElementById("lockIncomeListBtn").addEventListener("click", ()=>{
            incomeListUnlocked = false;
            render();
          });
          attachTxFilterListeners('inc', incomeFilter, true);
          document.querySelectorAll("[data-supplierinput]").forEach(inp=>inp.addEventListener("change",(e)=>{
            const rec = state.purchases.find(p=>p.id===inp.dataset.supplierinput);
            if(!rec) return;
            const before = Object.assign({}, rec);
            const val = e.target.value.trim();
            if(rec.supplier === val) return;
            rec.supplier = val;
            rec.updatedAt = new Date().toISOString();
            logHistory('sale', 'update', before, Object.assign({}, rec));
            saveData(); showToast("تم حفظ المورّد");
          }));
        } else {
          const hasPassword = !!(state.settings.incomeListPassword);
          const submit = () => {
            const p1 = document.getElementById("incomeListPassInput").value;
            const errEl = document.getElementById("incomeListError");
            if(hasPassword){
              if(!checkIncomePw(p1)){ errEl.textContent = "كلمة المرور غير صحيحة"; return; }
              incomeListUnlocked = true;
              render();
            } else {
              const p2 = document.getElementById("incomeListPassInput2").value;
              if(!p1 || p1.length < 4){ errEl.textContent = "كلمة المرور قصيرة جداً (٤ أحرف على الأقل)"; return; }
              if(p1 !== p2){ errEl.textContent = "كلمتا المرور غير متطابقتين"; return; }
              state.settings.incomeListPassword = hashPw(p1);
              saveData();
              incomeListUnlocked = true;
              render();
            }
          };
          document.getElementById("incomeListSubmitBtn").addEventListener("click", submit);
          document.getElementById("incomeListPassInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") submit(); });
        }
      } else if(reportsSubTab==="modifications"){
        attachTxFilterListeners('hist', historyFilter, true);
      } else if(reportsSubTab==="settings"){
        document.getElementById("saveSettingsBtn").addEventListener("click", ()=>{
          const days = parseInt(document.getElementById("overdueDaysInput").value,10);
          const cur = document.getElementById("currencyInput").value.trim() || "₪";
          state.settings.overdueDays = isNaN(days)?45:days;
          state.settings.currency = cur;
          state.settings.showCurrency = document.getElementById("showCurrencyInput").value !== "no";
          saveData(); showToast("تم حفظ الإعدادات"); render();
        });
        document.getElementById("exportBtn").addEventListener("click", exportBackup);
        document.getElementById("saveLockBtn").addEventListener("click", ()=>{
          const v = document.getElementById("lockedBeforeInput").value;
          if(v) state.settings.lockedBefore = v; else delete state.settings.lockedBefore;
          const dl = parseFloat(document.getElementById("defaultLimitInput").value)||0;
          if(dl > 0) state.settings.defaultCreditLimit = dl; else delete state.settings.defaultCreditLimit;
          saveData(); showToast("تم حفظ تاريخ إغلاق الفترات"); render();
        });
        document.getElementById("staffModeBtn").addEventListener("click", ()=>{
          if(!confirm("سيُفعَّل وضع الموظف على هذا الجهاز ولن تتمكن من الخروج منه إلا بكلمة مرور حسابك. متابعة؟")) return;
          localStorage.setItem("staffMode","1"); currentTab = "customers"; render();
        });
        document.getElementById("wrapCellsInput").addEventListener("change",(e)=>{
          state.settings.wrapCells = e.target.value === "yes";
          saveData(); render();
        });
        document.querySelectorAll("[data-colkey]").forEach(cb=>cb.addEventListener("change",(e)=>{
          if(!state.settings.columns) state.settings.columns = {};
          state.settings.columns[cb.dataset.colkey] = e.target.checked;
          saveData(); render();
        }));
        document.getElementById("resetPassBtn").addEventListener("click", ()=>{
          const email = fbAuth.currentUser && fbAuth.currentUser.email;
          if(!email) return;
          fbAuth.sendPasswordResetEmail(email)
            .then(()=>showToast("تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك"))
            .catch(err=>showToast(translateAuthError(err.code)));
        });
        document.getElementById("signOutBtn").addEventListener("click", ()=>{
          if(confirm("هل تريد تسجيل الخروج؟")) fbAuth.signOut();
        });
        const linkGoogleBtn = document.getElementById("linkGoogleBtn");
        if(linkGoogleBtn) linkGoogleBtn.addEventListener("click", ()=>{
          const u = fbAuth.currentUser;
          if(!u) return;
          const provider = new firebase.auth.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: 'select_account' });
          u.linkWithPopup(provider)
            .then(()=>showToast("تم ربط حساب Google، يمكنك الآن الدخول به"))
            .catch(err=>showToast(err.code==='auth/credential-already-in-use'
              ? 'حساب Google هذا مرتبط بمستخدم آخر، احذفه من Firebase أولاً'
              : translateAuthError(err.code)));
        });
        const enableTotpBtn = document.getElementById("enableTotpBtn");
        if(enableTotpBtn) enableTotpBtn.addEventListener("click", openTotpSetupModal);
        const disableTotpBtn = document.getElementById("disableTotpBtn");
        if(disableTotpBtn) disableTotpBtn.addEventListener("click", openTotpDisableModal);
        const resetIncomeBtn = document.getElementById("resetIncomeListPassBtn");
        if(resetIncomeBtn){
          resetIncomeBtn.addEventListener("click", ()=>{
            if(confirm("سيتم حذف كلمة مرور قائمة الدخل الحالية، وستحتاج لإنشاء واحدة جديدة عند الدخول للشاشة. متابعة؟")){
              delete state.settings.incomeListPassword;
              incomeListUnlocked = false;
              saveData(); showToast("تم إعادة تعيين كلمة المرور"); render();
            }
          });
        }
        const importBtn = document.getElementById("importTaqseetBtn");
        if(importBtn && !state.settings.importedTaqseet2024) importBtn.addEventListener("click", importTaqseet2024);
        const importOldDebtsBtn = document.getElementById("importOldDebtsBtn");
        if(importOldDebtsBtn && !state.settings.importedOldDebtsPre2023) importOldDebtsBtn.addEventListener("click", importOldDebtsPre2023);
      }
      // statistics sub-tab has no interactive elements beyond the sub-tab nav above
    }
  }

  window.AppAPI = { pgSlice, pgReset: ()=>{ Object.keys(pgLimits).forEach(k=>delete pgLimits[k]); }, isCashReceipt, get state(){return state;}, save:saveData, render, money, esc, fmtDate, uid, toast:showToast, logHistory, computeAccounts, allCustomerNames };

  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{
      navigator.serviceWorker.register('service-worker.js').catch(()=>{});
    });
  }
})();
