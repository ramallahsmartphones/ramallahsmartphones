(function(){
"use strict";
const A=()=>window.AppAPI, S=()=>A().state;
const E=v=>A().esc(v), M=v=>A().money(v), D=v=>A().fmtDate(v);
const n=v=>Number(v)||0, today=()=>new Date().toISOString().slice(0,10);
const sum=(arr,f)=>arr.reduce((t,x)=>t+n(f(x)),0);
const isCash=p=>!p.kind||p.kind==='payment';
let sub='accounts';

function addMonths(d,k){const x=new Date(d);if(isNaN(x))return d;x.setMonth(x.getMonth()+k);return x.toISOString().slice(0,10);}
function dueCount(pl){let c=0;for(let k=0;k<n(pl.count);k++){if(addMonths(pl.firstDue,k)<=today())c++;}return c;}

// ---------- generic small form modal ----------
function form(title,fields,onSave){
  const w=document.createElement('div');w.className='overlay';
  w.innerHTML=`<div class="modal" style="max-width:440px"><h3>${title}</h3><div class="grid2">${fields.map(f=>`
    <div class="field" style="${f.wide?'grid-column:1/-1':''}"><label>${f.label}</label>${f.options
      ?`<select id="x_${f.id}">${f.options.map(o=>`<option value="${E(o[0])}">${E(o[1])}</option>`).join('')}</select>`
      :`<input id="x_${f.id}" type="${f.type||'text'}" value="${E(f.value==null?'':f.value)}">`}</div>`).join('')}</div>
    <div class="modal-actions"><button class="btn btn-ghost" data-x="c">إلغاء</button><button class="btn btn-primary" data-x="s">حفظ</button></div></div>`;
  document.body.appendChild(w);
  w.addEventListener('click',e=>{
    if(e.target===w||e.target.dataset.x==='c') w.remove();
    if(e.target.dataset.x==='s'){
      const v={};fields.forEach(f=>v[f.id]=w.querySelector('#x_'+f.id).value.trim());
      if(onSave(v)!==false) w.remove();
    }});
}
const done=()=>{A().save();A().render();};
const need=(c,m)=>{if(!c){A().toast(m);return true;}return false;};

// ---------- calculations ----------
function accBal(a){const s=S();
  return n(a.opening)+sum(s.payments.filter(p=>p.accountId===a.id&&isCash(p)),p=>p.amount)
    -sum(s.supplierTx.filter(t=>t.type==='payment'&&t.accountId===a.id),t=>t.amount);}
const supNames=()=>[...new Set(S().supplierTx.map(t=>t.supplier).concat(S().inventory.map(i=>i.supplier)).filter(Boolean))].sort();
const supBal=nm=>{const t=S().supplierTx.filter(x=>x.supplier===nm);
  return sum(t.filter(x=>x.type==='purchase'),x=>x.amount)-sum(t.filter(x=>x.type==='payment'),x=>x.amount);};

// customers are matched by id (customerId, or looked up from the name for records not yet stamped) — renames can't split an account
function ctx(){const s=S(),m={},by={};s.customers.forEach(c=>{m[c.name]=c.id;by[c.id]=c;});
  return {s,by,key:(r,f)=>r.customerId||m[r[f||'customerName']]||('n:'+r[f||'customerName']),nm:(k,fb)=>by[k]?by[k].name:fb};}
function groups(){const {s,key,nm}=ctx(),g={};
  const get=(k,fb)=>g[k]||(g[k]={id:k,name:nm(k,fb),ps:[],rec:0});
  s.purchases.forEach(p=>get(key(p),p.customerName).ps.push(p));
  s.payments.forEach(p=>{get(key(p),p.customerName).rec+=n(p.amount);});
  return Object.values(g);}
const chqName=c=>{const u=S().customers.find(x=>x.id===c.customerId);return u?u.name:c.customer;};

// FIFO: customer receipts are applied to the oldest sales first; what's left is aged by sale date
function aging(){const now=Date.now(),res=[];
  groups().forEach(gr=>{let rec=gr.rec;const bk=[0,0,0,0];
    gr.ps.slice().sort((x,y)=>(x.date||'').localeCompare(y.date||'')).forEach(p=>{
      const pr=n(p.price),paid=Math.min(pr,rec);rec-=paid;const u=pr-paid;if(u<=0)return;
      const age=Math.floor((now-new Date(p.date))/864e5);bk[age<=30?0:age<=60?1:age<=90?2:3]+=u;});
    const t=bk[0]+bk[1]+bk[2]+bk[3];if(t>0.009)res.push({id:gr.id,name:gr.name,bk,t});});
  return res.sort((x,y)=>y.t-x.t);}

function planRows(){const rows=[];
  groups().forEach(gr=>{const ps=gr.ps;if(!ps.some(p=>p.plan))return;const rec=gr.rec;
    let exp=0,next=null,nextAmt=0;
    ps.forEach(p=>{
      if(!p.plan){if((p.date||'')<=today())exp+=n(p.price);return;}
      const c=n(p.plan.count),a=n(p.plan.amount),up=Math.max(0,n(p.price)-c*a),dc=dueCount(p.plan);
      if((p.date||'')<=today())exp+=up;exp+=Math.min(dc,c)*a;
      if(dc<c){const d=addMonths(p.plan.firstDue,dc);if(!next||d<next){next=d;nextAmt=a;}}});
    rows.push({id:gr.id,name:gr.name,bal:sum(ps,p=>p.price)-rec,late:Math.max(0,exp-rec),next,nextAmt});});
  return rows.sort((x,y)=>y.late-x.late);}

function waLink(key,msg){
  const c=S().customers.find(x=>x.id===key)||S().customers.find(x=>x.name===key);let d=((c&&c.phone)||'').replace(/\D/g,'');
  if(!d)return null;if(d.startsWith('00'))d=d.slice(2);else if(d.startsWith('0'))d='970'+d.slice(1);else if(d.length===9)d='970'+d;
  return 'https://wa.me/'+d+'?text='+encodeURIComponent(msg);}

// ---------- views ----------
function vAcc(){const s=S(),un=s.payments.filter(p=>!p.accountId&&isCash(p));
  return `<div class="card"><div class="card-head"><h2>الصناديق والحسابات البنكية</h2><button class="btn btn-primary btn-sm" data-act="addAcc">+ حساب</button></div>
  ${s.accounts.length?`<div class="table-wrap"><table><thead><tr><th>الحساب</th><th>النوع</th><th>افتتاحي</th><th>الرصيد الحالي</th><th></th></tr></thead><tbody>
  ${s.accounts.map(a=>`<tr><td class="name-cell">${E(a.name)}</td><td>${a.type==='bank'?'بنك':'صندوق'}</td><td class="num">${M(a.opening)}</td><td class="num">${M(accBal(a))}</td><td><button class="icon-btn" data-act="delAcc" data-id="${a.id}">✕</button></td></tr>`).join('')}
  </tbody><tfoot><tr><td style="font-weight:800">الإجمالي</td><td></td><td></td><td class="num" style="font-weight:800">${M(sum(s.accounts,accBal))}</td><td></td></tr></tfoot></table></div>`
  :'<div class="empty"><b>لا توجد حسابات</b>أضف صندوقاً أو حساباً بنكياً، ثم اختره عند تسجيل كل قبض.</div>'}
  <p class="hint">مقبوضات بلا حساب محدد: ${un.length} (${M(sum(un,x=>x.amount))}) — لا تدخل في أرصدة الحسابات.</p></div>`;}

function vInv(){const s=S(),free=s.purchases.filter(p=>!s.inventory.some(i=>i.purchaseId===p.id))
    .sort((x,y)=>(y.date||'').localeCompare(x.date||'')).slice(0,150);
  const opts=`<option value="">ربط ببيعة…</option>`+free.map(p=>`<option value="${p.id}">${E(p.customerName)} — ${E(p.productName||'')} — ${D(p.date)}</option>`).join('');
  const sups=supNames();
  return `<div class="card"><div class="card-head"><h2>المخزون</h2><button class="btn btn-primary btn-sm" data-act="addItem">+ جهاز</button></div>
  <p class="hint">في المخزون: ${s.inventory.filter(i=>i.status!=='sold').length} جهاز · قيمته ${M(sum(s.inventory.filter(i=>i.status!=='sold'),i=>i.cost))}. ربط الجهاز ببيعة يضبط التكلفة والربح والمورّد فيها تلقائياً.</p>
  ${s.inventory.length?`<div class="table-wrap"><table style="table-layout:auto"><thead><tr><th>الجهاز</th><th>IMEI</th><th>المورّد</th><th>التكلفة</th><th>الحالة</th><th></th></tr></thead><tbody>
  ${A().pgSlice('inv',s.inventory.slice().sort((x,y)=>(y.date||'').localeCompare(x.date||''))).map(i=>`<tr><td class="name-cell">${E(i.name)}</td><td class="muted">${E(i.imei)||'—'}</td><td>${E(i.supplier)||'—'}</td><td class="num">${M(i.cost)}</td>
  <td>${i.status==='sold'?'<span class="badge badge-ok">مباع</span>':`<select data-link="${i.id}">${opts}</select>`}</td><td><button class="icon-btn" data-act="delItem" data-id="${i.id}">✕</button></td></tr>`).join('')}
  </tbody></table></div>`:'<div class="empty"><b>المخزون فارغ</b></div>'}</div>
  <div class="card"><div class="card-head"><h2>ذمم الموردين</h2><button class="btn btn-primary btn-sm" data-act="supPay">+ دفعة لمورّد</button></div>
  ${sups.length?`<div class="table-wrap"><table><thead><tr><th>المورّد</th><th>مشتريات</th><th>مدفوع</th><th>المتبقي عليك</th></tr></thead><tbody>
  ${sups.map(nm=>{const t=s.supplierTx.filter(x=>x.supplier===nm);return `<tr><td class="name-cell">${E(nm)}</td><td class="num">${M(sum(t.filter(x=>x.type==='purchase'),x=>x.amount))}</td><td class="num">${M(sum(t.filter(x=>x.type==='payment'),x=>x.amount))}</td><td class="num debit">${M(supBal(nm))}</td></tr>`;}).join('')}
  </tbody></table></div>`:'<div class="empty"><b>لا توجد ذمم</b></div>'}</div>`;}

function vPlans(){const rows=planRows();
  return `<div class="card"><div class="card-head"><h2>جدولة الأقساط والتنبيهات</h2><button class="btn btn-primary btn-sm" data-act="addPlan">+ جدول لعملية بيع</button></div>
  <p class="hint">المتأخر = ما استحق حتى اليوم (الدفعة الأولى + الأقساط المستحقة) ناقص كل مقبوضات العميل. العمليات بلا جدول تُعتبر مستحقة فوراً.</p>
  ${rows.length?`<div class="table-wrap"><table style="table-layout:auto"><thead><tr><th>العميل</th><th>المتبقي</th><th>المتأخر</th><th>القسط القادم</th><th></th></tr></thead><tbody>
  ${A().pgSlice('plans',rows).map(r=>`<tr><td class="name-cell">${E(r.name)}</td><td class="num">${M(Math.max(0,r.bal))}</td><td class="num ${r.late>0?'debit':''}">${M(r.late)}</td><td>${r.next?D(r.next)+' · '+M(r.nextAmt):'—'}</td>
  <td>${r.late>0?`<button class="btn btn-ghost btn-sm" data-act="remind" data-cid="${E(r.id)}" data-name="${E(r.name)}" data-late="${r.late}">تذكير واتساب</button>`:''}</td></tr>`).join('')}
  </tbody></table></div>`:'<div class="empty"><b>لا توجد جداول أقساط</b>اضغط «+ جدول» وحدد عملية بيع.</div>'}</div>`;}

function vChq(){const s=S(),st={pending:['معلّق','badge-warn'],cashed:['محصَّل','badge-ok'],returned:['مرتجع','badge-bad']};
  return `<div class="card"><div class="card-head"><h2>الشيكات والكمبيالات</h2><button class="btn btn-primary btn-sm" data-act="addChq">+ شيك</button></div>
  ${s.cheques.length?`<div class="table-wrap"><table style="table-layout:auto"><thead><tr><th>العميل</th><th>الرقم</th><th>البنك</th><th>المبلغ</th><th>الاستحقاق</th><th>الحالة</th><th></th></tr></thead><tbody>
  ${A().pgSlice('chq',s.cheques.slice().sort((x,y)=>(x.dueDate||'').localeCompare(y.dueDate||''))).map(c=>`<tr><td class="name-cell">${E(chqName(c))}</td><td>${E(c.number)}</td><td>${E(c.bank)||'—'}</td><td class="num">${M(c.amount)}</td><td>${D(c.dueDate)}</td>
  <td><span class="badge ${st[c.status][1]}">${st[c.status][0]}</span></td><td>${c.status==='pending'?`<button class="btn btn-ghost btn-sm" data-act="chq" data-id="${c.id}" data-st="cashed">تحصيل</button> <button class="btn btn-ghost btn-sm" data-act="chq" data-id="${c.id}" data-st="returned">مرتجع</button>`:''}</td></tr>`).join('')}
  </tbody></table></div>`:'<div class="empty"><b>لا توجد شيكات</b></div>'}
  <p class="hint">عند «تحصيل» يُنشأ قبض تلقائياً للعميل في الحساب المحدد.</p></div>`;}

function vRep(){const s=S(),ag=aging(),tot=[0,1,2,3].map(i=>sum(ag,r=>r.bk[i]));
  const recv=sum(ag,r=>r.t),invV=sum(s.inventory.filter(i=>i.status!=='sold'),i=>i.cost),cash=sum(s.accounts,accBal),pay=sum(supNames(),supBal);
  const mo={},g=k=>mo[k]=mo[k]||{i:0,o:0};
  s.payments.filter(isCash).forEach(p=>{const k=(p.date||'').slice(0,7);if(k)g(k).i+=n(p.amount);});
  s.supplierTx.filter(t=>t.type==='payment').forEach(t=>{const k=(t.date||'').slice(0,7);if(k)g(k).o+=n(t.amount);});
  const ks=Object.keys(mo).sort().reverse().slice(0,24);
  return `<div class="card"><div class="card-head"><h2>ميزانية مبسّطة</h2></div><div class="cstats">
  <div class="cstat"><b>${M(recv)}</b><small>ذمم العملاء</small></div><div class="cstat"><b>${M(invV)}</b><small>قيمة المخزون</small></div>
  <div class="cstat"><b>${M(cash)}</b><small>الصناديق والبنوك</small></div><div class="cstat"><b class="debit">${M(pay)}</b><small>ذمم الموردين (عليك)</small></div>
  <div class="cstat"><b>${M(recv+invV+cash-pay)}</b><small>صافي رأس المال</small></div>
  <div class="cstat"><b>${M(sum(s.payments.filter(p=>!isCash(p)),p=>p.amount))}</b><small>خصومات ومرتجعات (غير نقدية)</small></div></div></div>
  <div class="card"><div class="card-head"><h2>أعمار الديون</h2><button class="btn btn-ghost btn-sm" data-act="csv">تصدير CSV</button></div>
  ${ag.length?`<div class="table-wrap"><table style="table-layout:auto"><thead><tr><th>العميل</th><th>0-30</th><th>31-60</th><th>61-90</th><th>+90</th><th>الإجمالي</th></tr></thead><tbody>
  ${A().pgSlice('aging',ag).map(r=>`<tr><td class="name-cell">${E(r.name)}</td>${r.bk.map(v=>`<td class="num muted">${v?M(v):'—'}</td>`).join('')}<td class="num">${M(r.t)}</td></tr>`).join('')}
  </tbody><tfoot><tr><td style="font-weight:800">الإجمالي</td>${tot.map(v=>`<td class="num" style="font-weight:800">${M(v)}</td>`).join('')}<td class="num" style="font-weight:800">${M(recv)}</td></tr></tfoot></table></div>`:'<div class="empty"><b>لا توجد ديون</b></div>'}</div>
  <div class="card"><div class="card-head"><h2>التدفق النقدي الشهري</h2></div>
  ${ks.length?`<div class="table-wrap"><table><thead><tr><th>الشهر</th><th>داخل (مقبوضات)</th><th>خارج (موردون)</th><th>الصافي</th></tr></thead><tbody>
  ${ks.map(k=>`<tr><td class="name-cell">${k}</td><td class="num credit">${M(mo[k].i)}</td><td class="num debit">${M(mo[k].o)}</td><td class="num">${M(mo[k].i-mo[k].o)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><b>لا توجد بيانات</b></div>'}</div>`;}

// ---------- actions ----------
const acctOpts=()=>[['','—']].concat(S().accounts.map(a=>[a.id,a.name]));
function act(a,d){const s=S(),U=A().uid;
  if(a==='addAcc') form('حساب جديد',[{id:'name',label:'الاسم',wide:1},{id:'type',label:'النوع',options:[['cash','صندوق'],['bank','بنك']]},{id:'opening',label:'رصيد افتتاحي',type:'number'}],
    v=>{if(need(v.name,'أدخل الاسم'))return false;s.accounts.push({id:U('acc'),name:v.name,type:v.type,opening:n(v.opening)});done();});
  else if(a==='delAcc'){if(!confirm('حذف الحساب؟ (تبقى المقبوضات المرتبطة به بلا حساب)'))return;s.accounts=s.accounts.filter(x=>x.id!==d.id);done();}
  else if(a==='addItem') form('جهاز جديد في المخزون',[{id:'name',label:'الجهاز',wide:1},{id:'imei',label:'IMEI (اختياري)'},{id:'supplier',label:'المورّد'},{id:'cost',label:'التكلفة',type:'number'},{id:'date',label:'التاريخ',type:'date',value:today()},{id:'debt',label:'ذمة على المورّد؟',options:[['yes','نعم'],['no','لا (مدفوع)']]}],
    v=>{if(need(v.name&&n(v.cost),'أدخل الجهاز والتكلفة'))return false;const it={id:U('itm'),name:v.name,imei:v.imei,supplier:v.supplier,cost:n(v.cost),date:v.date,status:'in'};s.inventory.push(it);
      if(v.debt==='yes'&&v.supplier)s.supplierTx.push({id:U('stx'),supplier:v.supplier,type:'purchase',amount:it.cost,date:v.date,itemId:it.id,notes:v.name});done();});
  else if(a==='delItem'){if(!confirm('حذف الجهاز وذمّته على المورّد؟'))return;s.inventory=s.inventory.filter(x=>x.id!==d.id);s.supplierTx=s.supplierTx.filter(x=>x.itemId!==d.id);done();}
  else if(a==='supPay'){const sp=supNames();if(need(sp.length,'لا يوجد موردون بعد'))return;
    form('دفعة لمورّد',[{id:'supplier',label:'المورّد',options:sp.map(x=>[x,x])},{id:'amount',label:'المبلغ',type:'number'},{id:'accountId',label:'من حساب',options:acctOpts()},{id:'date',label:'التاريخ',type:'date',value:today()}],
      v=>{if(need(n(v.amount),'أدخل المبلغ'))return false;s.supplierTx.push({id:U('stx'),supplier:v.supplier,type:'payment',amount:n(v.amount),date:v.date,accountId:v.accountId});done();});}
  else if(a==='addPlan'){const free=s.purchases.filter(p=>!p.plan).sort((x,y)=>(y.date||'').localeCompare(x.date||'')).slice(0,200);if(need(free.length,'لا توجد عمليات بيع'))return;
    form('جدول أقساط',[{id:'pid',label:'عملية البيع',wide:1,options:free.map(p=>[p.id,`${p.customerName} — ${p.productName||''} — ${D(p.date)} — ${p.price}`])},{id:'count',label:'عدد الأقساط',type:'number'},{id:'amount',label:'قيمة القسط',type:'number'},{id:'firstDue',label:'تاريخ أول قسط',type:'date',value:today()}],
      v=>{if(need(n(v.count)>0&&n(v.amount)>0,'أدخل عدد الأقساط وقيمتها'))return false;const p=s.purchases.find(x=>x.id===v.pid),b=Object.assign({},p);
        p.plan={count:n(v.count),amount:n(v.amount),firstDue:v.firstDue};p.updatedAt=new Date().toISOString();A().logHistory('sale','update',b,Object.assign({},p));done();});}
  else if(a==='remind'){const nxt=planRows().find(r=>r.id===d.cid),msg=`السلام عليكم ${d.name}، نذكّركم بوجود مبلغ مستحق ${M(d.late)}${nxt&&nxt.next?` والقسط القادم بتاريخ ${D(nxt.next)}`:''}. شكراً لكم — مكة للهواتف الذكية`;
    const l=waLink(d.cid,msg);if(!l){A().toast('لا يوجد رقم هاتف لهذا العميل');return;}window.open(l,'_blank');}
  else if(a==='addChq'){const cn=s.customers.slice().sort((x,y)=>x.name.localeCompare(y.name,'ar'));if(need(cn.length,'لا يوجد عملاء'))return;
    form('شيك جديد',[{id:'customer',label:'العميل',wide:1,options:cn.map(x=>[x.id,x.name])},{id:'number',label:'رقم الشيك'},{id:'bank',label:'البنك'},{id:'amount',label:'المبلغ',type:'number'},{id:'dueDate',label:'تاريخ الاستحقاق',type:'date',value:today()},{id:'accountId',label:'يُودَع في',options:acctOpts()}],
      v=>{if(need(n(v.amount),'أدخل المبلغ'))return false;const cu=s.customers.find(x=>x.id===v.customer);s.cheques.push({id:U('chq'),customer:cu?cu.name:'',customerId:v.customer,number:v.number,bank:v.bank,amount:n(v.amount),dueDate:v.dueDate,accountId:v.accountId,status:'pending'});done();});}
  else if(a==='chq'){const c=s.cheques.find(x=>x.id===d.id);if(!c)return;c.status=d.st;
    if(d.st==='cashed'){const now=new Date().toISOString(),p={id:U('pay'),customerName:chqName(c),customerId:c.customerId||'',date:today(),amount:c.amount,notes:'تحصيل شيك رقم '+c.number,accountId:c.accountId||'',createdAt:now,updatedAt:now};
      s.payments.push(p);A().logHistory('receipt','create',null,Object.assign({},p));}done();}
  else if(a==='csv'){const rows=[['العميل','0-30','31-60','61-90','+90','الإجمالي']].concat(aging().map(r=>[r.name].concat(r.bk,[r.t])));
    const blob=new Blob(['\ufeff'+rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n')],{type:'text/csv'});
    const u=URL.createObjectURL(blob),el=document.createElement('a');el.href=u;el.download='أعمار-الديون.csv';document.body.appendChild(el);el.click();el.remove();setTimeout(()=>URL.revokeObjectURL(u),3000);}
}
function link(itemId,pid){if(!pid)return;const s=S(),it=s.inventory.find(x=>x.id===itemId),p=s.purchases.find(x=>x.id===pid);if(!it||!p)return;
  const b=Object.assign({},p);it.purchaseId=pid;it.status='sold';p.cost=n(it.cost);p.profit=n(p.price)-n(it.cost);if(it.supplier)p.supplier=it.supplier;p.updatedAt=new Date().toISOString();
  A().logHistory('sale','update',b,Object.assign({},p));done();}

function render(){return ({accounts:vAcc,inv:vInv,plans:vPlans,chq:vChq,rep:vRep}[sub]||vAcc)();}
function bind(){const root=document.getElementById('tabContent');
  root.addEventListener('click',e=>{const t=e.target.closest('[data-act],[data-sub]');if(!t)return;
    if(t.dataset.sub){sub=t.dataset.sub;A().pgReset();A().render();return;}act(t.dataset.act,t.dataset);});
  root.addEventListener('change',e=>{if(e.target.dataset.link)link(e.target.dataset.link,e.target.value);});}
window.Ext={render,bind,getSub:()=>sub,setSub:k=>{sub=k;A().pgReset();}};
})();
