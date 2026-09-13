/* =============================================================================
   M3XI STUDIO — SHARED CORE

   One file behind every Studio page. It was a single 1,900-line document until
   the Studio was split into images / video / worlds / business / library /
   pricing / account; everything that was common — the design system's
   behaviour, sign-in, the credit ledger calls, the top-up modal, the lightbox,
   reveal-on-scroll — lives here so the pages stay thin.

   HOW PAGES OPT IN: they don't. Every page loads this whole file and simply
   omits the markup it doesn't need. `$` returns an inert stand-in for anything
   missing (see below), so wiring a handler to a button that isn't on this page
   does nothing instead of throwing and killing the rest of the script.
   ============================================================================= */
/* The Supabase client comes off a CDN. When this was a static top-level import
   and the CDN was unreachable, the whole module failed to evaluate and EVERY
   handler on the page died with it — prompt box, buttons, lightbox, the lot.
   Now the failure is contained: accounts stop working, the page does not. */
/* The auth client is fetched from a CDN, and the page must NOT wait for it.
   A top-level `await import(...)` looks tidy and is a trap: while that promise
   is unsettled the whole module is suspended, so a CDN that hangs rather than
   fails takes every button on the page with it, silently and forever.
   So: start signed-out, wire everything up, and upgrade in the background. */
const SB_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';


/* An element that isn't here. Assigning to it, reading from it and calling
   through it are all no-ops, which is what lets one script serve nine pages.
   Deliberately NOT falsy-checkable: use document.getElementById directly when
   the code needs to know whether something really exists. */
const __VOID = new Proxy(function(){}, {
  get(t, k){
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
    if (k === 'style' || k === 'classList' || k === 'dataset') return __VOID;
    if (k === 'files') return [];
    if (k === 'checked') return false;
    if (k === Symbol.toPrimitive) return () => '';
    return __VOID;
  },
  set(){ return true; },
  apply(){ return __VOID; },
  has(){ return true; },
});

/* Modules are deferred, so anything registered for DOMContentLoaded after the
   event has already fired would never run. */
function onReady(fn){
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, {once:true});
  else fn();
}

const $=s=>document.querySelector(s)||__VOID;const $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

/* ================= portfolio ================= */
const PIECES=[
 {u:'https://v3b.fal.media/files/b/0aa5ae21/Wda12B32TKVOD2l6I3cGC.jpg',n:'Dusk showroom',tag:'space',lab:'Photoreal'},
 {u:'https://v3b.fal.media/files/b/0aa5ae10/NOuG7If89h0Ldk5fok8QW.jpg',n:'Golden hour, drawn',tag:'ink',lab:'Anime'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0e/fJWJN-3OV2bBbT2ZHUj-4.jpg',n:'Rain scene 04',tag:'cine',lab:'Film still'},
 {u:'https://v3b.fal.media/files/b/0aa5ae21/sFwKKyCA-DzH0i6bK0pB6.jpg',n:'Spread: the city',tag:'ink',lab:'Manga'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0e/XomPDS-MR8YNysdErl4nm.jpg',n:'Penthouse, midday',tag:'space',lab:'Photoreal'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0f/ueiUaIJqI58-AWhodbd0C.jpg',n:'The lantern crossing',tag:'cine',lab:'Story'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0e/-W5THKxgRSpok6zaaPFsZ.jpg',n:'Morning study',tag:'space',lab:'Digital twin'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0f/yowFMgeT752Y_rYwSyIP8.jpg',n:'Presenter 01',tag:'prod',lab:'UGC avatar'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0f/P_5hymWZreaaKZH5-XX2j.jpg',n:'Gallery light',tag:'space',lab:'Photoreal'},
 {u:'https://v3b.fal.media/files/b/0aa5ae0e/6eRIKA4lSd-zb93Iq1F1x.jpg',n:'Chair, studio',tag:'prod',lab:'Product'},
 {u:'https://v3b.fal.media/files/b/0aa5ae20/2LANjv1jCQUgpSwlujnHM.jpg',n:'Twilight listing',tag:'space',lab:'Key art'}
];
function lbShow(url,cap){
  $('#lbImg').src=url;$('#lbCap').textContent=cap;$('#lbOpen').href=url;$('#lb').style.display='flex';
}
const mas=$('#masonry');
PIECES.forEach(p=>{
  const d=document.createElement('figure');d.className='panel piece';d.dataset.tag=p.tag;
  d.innerHTML='<img loading="lazy" src="'+esc(p.u)+'" alt="'+esc(p.n)+'"><figcaption class="strip"><b>'+esc(p.n)+'</b><span class="tag">'+esc(p.lab)+'</span></figcaption>';
  d.onclick=()=>lbShow(p.u,p.n+' — generated in M3XI Studio');
  mas.appendChild(d);
});
$$('#filters .fbtn').forEach(b=>b.onclick=()=>{
  $$('#filters .fbtn').forEach(x=>x.classList.toggle('on',x===b));
  const f=b.dataset.f;
  $$('.piece').forEach(p=>{p.style.display=(f==='all'||p.dataset.tag===f)?'':'none';});
});
$('#lb').onclick=e=>{if(e.target.id==='lb')$('#lb').style.display='none';};
addEventListener('keydown',e=>{if(e.key==='Escape')$('#lb').style.display='none';});

/* ================= backend ================= */
const M3IX_BACKEND={
  fn:'https://tnlcuptfldwxtxajudoq.supabase.co/functions/v1/m3ix-generate',
  key:'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRubGN1cHRmbGR3eHR4YWp1ZG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODcxNDEsImV4cCI6MjEwMDA2MzE0MX0.mgS1gDa7qeBsTCaXmefpogg02kw7tCzn0uEYPAAuC90'
};
/* Generation is charged to an ACCOUNT, so the call must carry that person's
   token rather than the public anon key. Sending the anon key identifies nobody,
   and the backend — correctly — refuses to generate for nobody. */
async function sessionToken(){
  try{
    const sb=window.__sb;if(!sb)return null;
    const{data:{session}}=await sb.auth.getSession();
    return session&&session.access_token?session.access_token:null;
  }catch(e){return null;}
}
function promptSignIn(){
  glog('✗ Create a free account to generate — one tap with Google. It keeps every world you make in your own library.');
  const a=document.querySelector('#account');
  if(a)a.scrollIntoView({behavior:'smooth',block:'start'});
  const e=document.querySelector('#acctEmail');
  if(e)setTimeout(()=>e.focus(),450);
}
/* The out-of-credits moment gets a real pop-up, not a log line: balance,
   what happened, and the one useful button. Shown when a charge is refused
   (402) and when a successful generation drains the balance to exactly zero. */
let _topupShownAtZero=false;
function showTopUp(balance,message){
  if(balance===0){if(_topupShownAtZero)return;_topupShownAtZero=true;}
  const m=document.getElementById('topupModal');if(!m)return;
  const line=document.getElementById('topupLine');
  if(line)line.textContent=message
    ? message
    : 'That was the last of your build credits. Credits come with a business plan — everything you have built stays in your account.';
  m.style.display='flex';
}
onReady(function wireTopUp(){
  const m=document.getElementById('topupModal');if(!m)return;
  document.getElementById('topupClose').onclick=()=>{m.style.display='none';};
  document.getElementById('topupGo').onclick=()=>{
    m.style.display='none';
    /* #plans lives on pricing.html and nowhere else, so on every page where
       this modal actually appears — the generation benches — the one button
       that sells anything used to close the dialog and do nothing at all. */
    const plans=document.querySelector('#plans');
    if(plans)plans.scrollIntoView({behavior:'smooth',block:'start'});
    else location.href='business.html';   // credit packs are gone; plans are the only way to buy
  };
  m.addEventListener('click',e=>{if(e.target===m)m.style.display='none';});
});
/* ===================== VIDEO SHAPE, LENGTH, AND WHAT HAPPENS NEXT =====================
   A clip used to end its life as a URL in this panel. Now it can go two
   places: into the Editor to be cut with others, or into the public Library.
   ===================================================================================== */
let imgPortrait=false;
let vidAspect='9:16', vidDur='5';
onReady(()=>{
  const cost=()=>{
    const n=(vidDur==='10'?120:60)+' credits';
    const el=document.getElementById('vidCost');if(el)el.textContent=n;
    /* The switch shows the price of each engine, so the video button has to
       follow the length you chose rather than saying 60 for ever. */
    const tab=document.querySelector('.modeBtn[data-gmode="video"] .mCost');if(tab)tab.textContent=n;
  };
  document.querySelectorAll('.shapeBtn').forEach(b=>b.onclick=()=>{
    imgPortrait=b.dataset.shape==='portrait';
    document.querySelectorAll('.shapeBtn').forEach(x=>x.classList.toggle('on',x===b));
  });
  document.querySelectorAll('.aspBtn').forEach(b=>b.onclick=()=>{
    vidAspect=b.dataset.asp;document.querySelectorAll('.aspBtn').forEach(x=>x.classList.toggle('on',x===b));
  });
  document.querySelectorAll('.durBtn').forEach(b=>b.onclick=()=>{
    vidDur=b.dataset.dur;document.querySelectorAll('.durBtn').forEach(x=>x.classList.toggle('on',x===b));cost();
  });
  cost();
});

/* ===================== THE ENGINE SWITCH =====================================
   Images, video and words were three pages with the same prompt box drawn on
   each. They are one page now. The switch changes the controls under the box
   and nothing else: the prompt, the attachments, the credit code and the
   output panel are shared, so changing your mind costs you nothing you typed.

   The chosen engine rides in ?mode= so a link can open straight into video,
   and is remembered per browser so the Studio opens where you left it.
   ============================================================================ */
const GEN_MODES=['image','video','text'];
let genKind='image';
const MODE_COPY={
  image:{head:'Describe the shot',   note:'Up to 4 photos. The first steers the result.',
         cost:'1 credit per image. Prepaid — you can never spend more than you have. Credits come with a <a href="business.html">business plan</a>.',
         ph:'A bright Scandinavian penthouse living room at golden hour, floor-to-ceiling windows, cinematic photoreal…'},
  video:{head:'Describe the shot',   note:'Up to 4 photos. The first becomes the opening frame.',
         cost:'Video clip 60 credits at 5s, 120 at 10s. Prepaid — you can never spend more than you have. Credits come with a <a href="business.html">business plan</a>.',
         ph:'Slow dolly through a sunlit kitchen, steam rising from a cup, morning light, 35mm…'},
  text: {head:'What should it say',  note:'Photos are ignored when you are writing words.',
         cost:'2 credits per piece of writing. It runs on a free language model, so this is the cheapest thing in the Studio.',
         ph:'A listing description for a two-bedroom Victorian conversion in Peckham with a south-facing garden…'},
};
function applyGenMode(m,remember){
  if(!GEN_MODES.includes(m))m='image';
  genKind=m;
  window.__genMode=m;
  document.querySelectorAll('.modeBtn').forEach(b=>{
    const on=b.dataset.gmode===m;
    b.classList.toggle('on',on);
    b.setAttribute('aria-selected',on?'true':'false');
  });
  document.querySelectorAll('.modePane').forEach(p=>{p.hidden=p.dataset.pane!==m;});
  const c=MODE_COPY[m];
  const head=document.getElementById('promptHead');if(head)head.textContent=c.head;
  const note=document.getElementById('attachNote');if(note)note.textContent=c.note;
  const cost=document.getElementById('costNote');if(cost)cost.innerHTML=c.cost;
  const box=document.getElementById('genPrompt');if(box)box.placeholder=c.ph;
  if(remember){try{localStorage.setItem('m3xi.genmode',m);}catch(_){}}
  if(window.__updateIntentHint)window.__updateIntentHint();
}
onReady(()=>{
  if(!document.querySelector('.modeBtn'))return;          // not the generation page
  document.querySelectorAll('.modeBtn').forEach(b=>{
    b.onclick=()=>applyGenMode(b.dataset.gmode,true);
  });
  let want=new URLSearchParams(location.search).get('mode');
  if(!GEN_MODES.includes(want)){try{want=localStorage.getItem('m3xi.genmode');}catch(_){want=null;}}
  applyGenMode(GEN_MODES.includes(want)?want:'image',false);
});

/* ===================== SHARPEN MY PROMPT =====================================
   A toggle above every prompt box. On, the words you wrote are rewritten for
   the engine you picked before anything is generated, and the rewrite is
   PRINTED so you can see what was actually sent — a prompt that is silently
   replaced is worse than no help at all, because you cannot tell whether a bad
   result came from your idea or from the rewrite.

   It is off by default and it never blocks: if the language model is down, the
   generation goes ahead with your own words rather than failing.
   ============================================================================ */
const REFINE_KEY='m3xi.refine';
onReady(()=>{
  const t=document.getElementById('refineToggle');
  if(!t)return;
  try{t.checked=localStorage.getItem(REFINE_KEY)==='1';}catch(_){}
  t.addEventListener('change',()=>{try{localStorage.setItem(REFINE_KEY,t.checked?'1':'0');}catch(_){}});
});
const REFINE_SYSTEM={
  image:'You rewrite prompts for an image generator. Return ONE improved prompt and nothing else: no preamble, no quotes, no options, no explanation. Keep every concrete thing the writer asked for — subject, place, mood, named colours, camera or lens if given — and add only what a photographer would have decided anyway: lighting, lens, composition, materials, time of day. Never add people, text, logos or brands that were not asked for. Under 70 words.',
  video:'You rewrite prompts for a video generator that makes one continuous shot of a few seconds. Return ONE improved prompt and nothing else: no preamble, no quotes, no shot list, no explanation. Keep everything the writer asked for and add camera movement, pacing, lighting and lens. It is a SINGLE shot: never describe a cut, a second scene or a montage. Never add people, text, logos or brands that were not asked for. Under 60 words.',
  world:'You rewrite prompts for a generator that builds a whole walkable 3D place. Return ONE improved prompt and nothing else: no preamble, no quotes, no explanation. Keep every real detail the writer gave, especially anything describing an actual property, and add what a location scout would note: the layout, what is underfoot, the walls and ceiling, the light and where it comes from, what is visible through the openings. Describe the place in every direction, at standing eye level. Never invent an address, a price or a person. Under 90 words.',
  text:'You rewrite a writing brief so another model can answer it well. Return ONE improved brief and nothing else. Keep the writer\'s subject, facts and intent exactly; add only the missing shape of the request: who it is for, how long, what tone, what to leave out. Never invent facts, prices, addresses or measurements. Under 60 words.',
};
/** Returns the prompt to actually send. Never throws: a refusal or an outage
    falls back to what the person wrote. */
async function maybeRefine(prompt,kind){
  const t=document.getElementById('refineToggle');
  if(!t||!t.checked)return prompt;
  const text=String(prompt||'').trim();
  if(text.length<3)return prompt;
  try{
    glog('  sharpening your prompt …');
    const j=await backendCall({action:'refine',purpose:'prompt',code:creditCode()||undefined,
      system:REFINE_SYSTEM[kind]||REFINE_SYSTEM.image,prompt:text});
    const out=String(j.output||'').trim().replace(/^["'“‘]|["'”’]$/g,'').trim();
    if(!out)return prompt;
    glog('  sent instead: '+out);
    return out;
  }catch(e){
    glog('  (kept your own words — the prompt helper is unavailable: '+e.message+')');
    return prompt;
  }
}
window.__maybeRefine=maybeRefine;

/** Hand clips to the Editor. localStorage, not a query string: a provider URL
    is long and signed, and does not survive being put in an address bar. */
function sendToEditor(items,open){
  let box=[];try{box=JSON.parse(localStorage.getItem('m3xi.editor.inbox')||'[]');}catch(_){}
  box=box.concat(items);
  try{localStorage.setItem('m3xi.editor.inbox',JSON.stringify(box.slice(-24)));}catch(_){}
  if(open!==false)window.open('editor.html','_blank','noopener');
}

/* Publishing re-hosts the file into our own storage first. The provider's URL
   is not ours and has expired under the site before — the Library must not
   depend on it. */
async function publishVideo(url,title,promptText){
  const sb=window.__sb;
  if(!sb)throw new Error('Sign in first.');
  const{data:{session}}=await sb.auth.getSession();
  if(!session)throw new Error('Sign in to publish.');
  glog('Copying the video into M3XI storage…');
  const blob=await (await fetch(url,{mode:'cors'})).blob();
  const ext=(blob.type||'').includes('webm')?'webm':'mp4';
  const path=session.user.id+'/'+Date.now()+'-'+Math.random().toString(36).slice(2,8)+'.'+ext;
  const up=await sb.storage.from('videos').upload(path,blob,{contentType:blob.type||'video/mp4'});
  if(up.error)throw new Error('Upload failed: '+up.error.message);
  const pub=sb.storage.from('videos').getPublicUrl(path).data.publicUrl;
  const j=await backendCall({action:'video_publish',video_url:pub,title:title||'Untitled',
    prompt:promptText,aspect:vidAspect,source:'studio'});
  return j;
}

/** The panel under a finished image: open it, or take it into the Editor.
    Everything that comes out of the Studio except words and places can be cut
    on a timeline, so the way through to the Editor is offered every time
    rather than being something you have to know about. */
function imageActions(url){
  const box=document.createElement('div');box.className='srow';
  const a=document.createElement('a');
  a.className='btn sm ghost';a.href=url;a.target='_blank';a.rel='noopener';a.textContent='Open full size';
  const ed=document.createElement('button');
  ed.className='btn sm';ed.textContent='Open in the Editor';
  ed.title='Put this image on a timeline — add clips, sound and titles around it';
  ed.onclick=()=>{sendToEditor([{url,name:'Studio image',kind:'image'}]);glog('→ Sent to the Editor.');};
  box.appendChild(a);box.appendChild(ed);
  return box;
}

/** The panel under a finished clip: keep it, cut it, or show it to everyone. */
function videoActions(url,promptText){
  const box=document.createElement('div');box.className='srow';
  const a=document.createElement('a');a.className='btn sm ghost';a.href=url;a.target='_blank';a.rel='noopener';a.textContent='Open video';
  const ed=document.createElement('button');ed.className='btn sm';ed.textContent='Open in editor';
  ed.onclick=()=>sendToEditor([{url,name:'Studio clip',kind:'video'}]);
  const pb=document.createElement('button');pb.className='btn sm red';pb.textContent='Publish to Library';
  pb.onclick=async()=>{
    const t=prompt('Name this video for the Library — everyone on m3xi.com will see it.','');
    if(t===null)return;
    pb.disabled=true;pb.textContent='Publishing…';
    try{const j=await publishVideo(url,t,promptText);glog('✓ '+(j.message||'Sent to the Library.'));pb.textContent='Sent for review';}
    catch(e){glog('✗ '+e.message);pb.disabled=false;pb.textContent='Publish to Library';}
  };
  box.appendChild(a);box.appendChild(ed);box.appendChild(pb);
  return box;
}

async function backendCall(payload){
  const tok=await sessionToken();
  if(!tok){promptSignIn();throw new Error('Sign in to generate.');}
  const r=await fetch(M3IX_BACKEND.fn,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok,'apikey':M3IX_BACKEND.key},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({error:'Unreadable response from backend'}));
  if(j&&j.credits_remaining!=null){
    const el=document.getElementById('topCreditsN');if(el)el.textContent=Number(j.credits_remaining).toLocaleString();
    // The generation that lands you on zero is the moment to talk about
    // topping up — not the next one, which fails.
    if(Number(j.credits_remaining)===0)showTopUp(0);
  }
  if(j&&j.code==='signup_required'){promptSignIn();throw new Error(j.error||'Sign in to generate.');}
  if(!r.ok||j.error){
    if(r.status===402)showTopUp(null,j.error);
    throw new Error(j.error||('Backend HTTP '+r.status));
  }
  /* A world takes ten minutes and is polled every six seconds. Refreshing the
     whole account panel on every one of those answers meant a hundred polls,
     several queries each, all to redraw a balance that had not moved since the
     charge at the start. Refresh when the balance actually changes, and
     otherwise at most once a minute. */
  try{
    const bal=(j&&j.credits_remaining!=null)?Number(j.credits_remaining):null;
    const now=Date.now();
    const changed=bal!=null&&bal!==backendCall._bal;
    if(changed)backendCall._bal=bal;
    if(changed||now-(backendCall._at||0)>60000){
      backendCall._at=now;
      window.__refreshAccount&&window.__refreshAccount();
    }
  }catch(e){}
  return j;
}
async function wapi(payload){
  /* The anon key identifies nobody, so a world created with it had no owner
     and its enquiries reached no inbox. Send the session when there is one;
     the public actions still answer the anon key. */
  const tok=await sessionToken();
  const r=await fetch(M3IX_BACKEND.fn.replace('m3ix-generate','m3ix-worlds'),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(tok||M3IX_BACKEND.key),'apikey':M3IX_BACKEND.key},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({error:'Unreadable response'}));
  if(!r.ok||j.error)throw new Error(j.error||('HTTP '+r.status));
  return j;
}

/* ================= world generation (Marble via M3XI Cloud) ================= */
// The published demo world — somewhere to walk while a generation runs, and the
// fallback when a visitor has nothing of their own yet. It is AI-generated
// (Marble, from a text prompt) and must be labelled as such wherever it is offered.
const DEMO_WORLD_SLUG='generated-bedroom-first-marble-world-a2td';
async function genWorld(){
  let p=$('#genPrompt').value.trim();
  const imgs=attachments.map(a=>a.url);
  if(!p&&!imgs.length)return glog('✗ Describe the place you want, or attach 1–8 photos of a real room (shots from different spots in the same room), or both.');
  if(genMode()!=='backend')return glog('✗ Generation runs through M3XI Cloud — switch Mode back under Advanced.');
  try{
    if(p)p=await maybeRefine(p,'world');
    const model=(($('#epWorld')&&$('#epWorld').value.trim())||'marble-1.1');
    glog('→ Generating a full walkable 3D world ('+model+')'+(imgs.length?' from '+imgs.length+' photo(s)':' from your prompt')+' … (typically 3–10 min)');
    const q=await backendCall({action:'world_submit',prompt:p,image_urls:imgs,model,code:creditCode()||undefined});
    if(q.credits_remaining!=null)glog('  credits left: '+q.credits_remaining);
    glog('   World generation started.');
    // A world takes 3-10 minutes. Rather than leave the visitor watching a log
    // scroll, hand them somewhere to go: the demo world walks right now, and the
    // Library holds everything already published.
    $('#genOut').innerHTML=
      '<div class="empty" style="text-align:left">'+
      '<p class="price-note" style="margin:0 0 10px"><b>Building your world.</b> This takes 3–10 minutes. '+
      'You can leave this tab open — it publishes to your Library the moment it is ready.</p>'+
      '<div class="srow" style="margin-top:0">'+
      '<a class="btn sm red" href="walkthrough.html?world='+encodeURIComponent(DEMO_WORLD_SLUG)+'" target="_blank" rel="noopener">Walk the AI-generated demo meanwhile</a>'+
      '<a class="btn sm ghost" href="#library">See published walkthroughs</a>'+
      '</div></div>';
    let st=null;
    for(let i=0;i<120;i++){
      await new Promise(x=>setTimeout(x,6000));
      st=await backendCall({action:'world_status',operation_id:q.operation_id});
      if(st.done)break;
      if(st.error)throw new Error('Generation failed: '+JSON.stringify(st.error).slice(0,140));
      if(i%3===0){const pr=st.metadata&&(st.metadata.progress_pct??st.metadata.progress);glog('   status: '+(pr!=null?pr+'%':'generating …'));}
    }
    if(!st||!st.done)throw new Error('Still generating after 12 min — leave it, then press Generate world again later; it will pick the finished world up from your Marble account.');
    if(st.error)throw new Error('Generation failed on the provider side.');
    glog('✓ World generated — importing into your Library …');
    const im=await backendCall({action:'world_import',operation_id:q.operation_id});
    glog('✓ Published. World code: '+im.slug+(im.size_mb?' · '+im.size_mb+' MB':''));
    const wurl='walkthrough.html?world='+encodeURIComponent(im.slug)+'&embed=1';
    $('#genOut').innerHTML=(im.cover?'<img src="'+esc(im.cover)+'" alt="world cover">':'')+
      '<div class="srow"><a class="btn red" href="'+wurl+'" target="_blank" rel="noopener">Walk this world</a>'+
      (im.marble_url?'<a class="btn sm ghost" href="'+esc(im.marble_url)+'" target="_blank" rel="noopener">Open in Marble</a>':'')+'</div>'+
      '<p class="price-note">Published as “'+esc(im.name||'Generated world')+'” · code <b>'+esc(im.slug)+'</b> · owner edit key (keep safe): '+esc(im.edit_key)+'</p>';
    loadLibrary();
  }catch(e){glog('✗ '+e.message);}
}

/* ================= library ================= */
/* The Library is for visitors, not just account holders, so this one call goes
   out with the public key alone — backendCall demands a session and would push
   a signed-out reader at the sign-in box for something they are allowed to see. */
async function publicCall(payload){
  const r=await fetch(M3IX_BACKEND.fn,{method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+M3IX_BACKEND.key,apikey:M3IX_BACKEND.key},
    body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j.error)throw new Error(j.error||('HTTP '+r.status));
  return j;
}

async function loadVideoLibrary(){
  const grid=document.getElementById('vidGrid'),empty=document.getElementById('vidEmpty');
  if(!grid)return;
  try{
    const j=await publicCall({action:'video_list',limit:24});
    const vs=(j.videos||[]).filter(v=>v&&v.video_url);
    if(!vs.length){empty.style.display='';return;}
    empty.style.display='none';grid.innerHTML='';
    vs.forEach(v=>{
      const wide=(v.width&&v.height&&v.width>v.height);
      const card=document.createElement('article');card.className='wcard vcard'+(wide?' wide':'');
      const vid=document.createElement('video');
      vid.src=v.video_url;vid.muted=true;vid.loop=true;vid.playsInline=true;vid.preload='metadata';
      if(v.poster_url)vid.poster=v.poster_url;
      vid.controls=false;
      // Hovering previews, clicking plays properly — a wall of autoplaying
      // video is a wall of noise and a lot of bandwidth on a phone.
      card.onmouseenter=()=>vid.play().catch(()=>{});
      card.onmouseleave=()=>{vid.pause();vid.currentTime=0;};
      vid.onclick=()=>{vid.controls=true;vid.muted=false;vid.play().catch(()=>{});
        try{window.__sb&&window.__sb.rpc('m3ix_video_viewed',{p_id:v.id});}catch(_){}};
      card.appendChild(vid);
      const meta=document.createElement('div');meta.className='meta';
      const nm=document.createElement('span');nm.className='nm';nm.textContent=v.title||'Untitled';meta.appendChild(nm);
      if(v.maker_name){
        if(v.maker_link){const a=document.createElement('a');a.className='by';a.href=v.maker_link;a.target='_blank';a.rel='noopener nofollow';a.textContent=v.maker_name;meta.appendChild(a);}
        else{const sp=document.createElement('span');sp.className='by';sp.textContent=v.maker_name;meta.appendChild(sp);}
      }
      card.appendChild(meta);grid.appendChild(card);
    });
  }catch(e){empty.style.display='';}
}

async function loadLibrary(){
  const grid=$('#libGrid'),empty=$('#libEmpty');
  try{
    const j=await wapi({action:'list_published',limit:24});
    const ws=(j.worlds||[]).filter(w=>w&&w.slug);
    if(!ws.length){empty.style.display='';return;}
    // The module renders a richer version of this same grid (likes, maker,
    // avatar). Whichever finishes last must be that one, so hand over.
    setTimeout(()=>{try{window.__renderLibrary&&window.__renderLibrary();}catch(e){}},0);
    grid.innerHTML='';
    ws.forEach((w,i)=>{
      const d=document.createElement('div');d.className='panel wcard'+(i%3===1?' tilt-r':i%3===2?' tilt-l':'');
      const url='walkthrough.html?world='+encodeURIComponent(w.slug)+'&embed=1';
      d.innerHTML='<a class="cov" href="'+url+'" target="_blank" rel="noopener">'+
        (w.cover?'<img loading="lazy" src="'+esc(w.cover)+'" alt="'+esc(w.name)+' cover">':'<span class="ph">三X一</span>')+
        (w.source==='marble'?'<span class="aiBadge">AI-generated</span>':'')+'</a>'+
        '<div class="meta"><span class="nm"></span><a class="by" target="_blank" rel="noopener" style="display:none"></a>'+
        '<a class="btn sm ghost" href="'+url+'" target="_blank" rel="noopener">Walk</a></div>';
      d.querySelector('.nm').textContent=w.name||'World';
      if(w.creator&&w.creator.name){
        const by=d.querySelector('.by');by.style.display='';by.textContent='by '+w.creator.name;
        if(/^https?:\/\//.test(w.creator.url||''))by.href=w.creator.url;else by.removeAttribute('href');
      }
      grid.appendChild(d);
    });
    setTimeout(()=>{try{window.__renderLibrary&&window.__renderLibrary();}catch(e){}},0);
  }catch(e){
    empty.style.display='';
    empty.textContent='The Library could not load right now — check your connection and refresh.';
  }
}
loadLibrary();
loadVideoLibrary();

/* ================= studio (generation) ================= */
const glog=m=>{
  const l=document.getElementById('genLog');
  if(l){l.textContent+='\n'+m;l.scrollTop=l.scrollHeight;return;}
  /* No log panel on this page. pricing.html is the one that matters: its Buy
     buttons report through here, so "Opening secure checkout" and, more to the
     point, "checkout failed" were both going nowhere at all. Fall back to
     whatever status line the page does have, then to the console. */
  const alt=document.getElementById('balMsg2')||document.getElementById('acctMsg2')
          ||document.getElementById('balMsg')||document.getElementById('acctMsg');
  if(alt){alt.textContent=String(m).replace(/^[✓✗→▸\s]+/,'');return;}
  try{console.log('[M3XI]',m);}catch(_){}
};
/* The bring-your-own-fal-key mode is gone. Everything renders through the
   backend, which routes to our own render box; there is no key to paste. */
function falHeaders(){throw new Error('Direct provider mode has been removed.');}
const attachments=[];let lastImageUrl=null,lastVideoUrl=null;
/* WHAT AN ATTACHMENT LOOKS LIKE. A bare thumbnail told you a picture was
   attached but not which one: eight photos of the same room are eight almost
   identical squares. Each one is a card now — the picture, the file's real
   name, its size, and a remove button — which is how every chat app that takes
   files shows them, and it is legible at a glance. The picture is still there,
   so nothing is lost for someone who recognises the shot. */
function fmtBytes(n){
  if(!n&&n!==0)return '';
  if(n<1024)return n+' B';
  if(n<1024*1024)return Math.round(n/1024)+' KB';
  return (n/1048576).toFixed(n<10485760?1:0)+' MB';
}
function renderThumbs(){
  const t=$('#thumbs');
  if(!t||t===__VOID)return;
  t.innerHTML='';
  t.classList.toggle('has',attachments.length>0);
  attachments.forEach((a,i)=>{
    const d=document.createElement('div');
    d.className='att';
    const fig=document.createElement('span');fig.className='fig';
    if(a.url&&/^data:image|^https?:/.test(a.url)){
      const im=document.createElement('img');im.src=a.url;im.alt='';fig.appendChild(im);
    }else{
      fig.textContent='▢';fig.classList.add('gen');
    }
    const meta=document.createElement('span');meta.className='txt';
    const nm=document.createElement('span');nm.className='nm';nm.textContent=a.name||('Reference '+(i+1));
    nm.title=a.name||'';
    const sz=document.createElement('span');sz.className='sz';
    sz.textContent=[a.folder||'',fmtBytes(a.size)].filter(Boolean).join(' · ')||'image';
    meta.appendChild(nm);meta.appendChild(sz);
    const x=document.createElement('button');
    x.className='x';x.type='button';x.title='Remove '+(a.name||'this reference');
    x.setAttribute('aria-label','Remove '+(a.name||'this reference'));
    x.textContent='×';
    x.onclick=()=>{attachments.splice(i,1);renderThumbs();if(window.__updateIntentHint)window.__updateIntentHint();};
    d.appendChild(fig);d.appendChild(meta);d.appendChild(x);
    t.appendChild(d);
  });
}
function addFiles(files){
  [...files].forEach(f=>{
    if(attachments.length>=8)return;
    if(!f.type.startsWith('image/'))return;
    const img=new Image();
    const blobUrl=URL.createObjectURL(f);
    img.onload=()=>{
      const mx=1600,s=Math.min(1,mx/Math.max(img.width,img.height));
      const c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      const url=c.toDataURL('image/jpeg',0.9);
      /* The object URL held the whole file in memory for as long as the tab
         lived; the data URI above is the copy we actually send. */
      URL.revokeObjectURL(blobUrl);
      const rel=(f.webkitRelativePath||'').split('/').slice(0,-1).pop()||'';
      attachments.push({url,name:f.name,size:f.size,type:f.type,folder:rel});
      renderThumbs();glog('+ Attached '+f.name+(s<1?' (resized for upload)':''));
      if(window.__updateIntentHint)window.__updateIntentHint();
    };
    img.onerror=()=>{URL.revokeObjectURL(blobUrl);glog('✗ Could not read '+f.name+' — is it really an image?');};
    img.src=blobUrl;
  });
}
$('#btnAttach').onclick=()=>$('#attachInput').click();
$('#attachInput').onchange=e=>{takeFiles(e.target.files);e.target.value='';};
$('#btnAttachFolder').onclick=()=>$('#attachDirInput').click();
$('#attachDirInput').onchange=e=>{takeFiles(e.target.files);e.target.value='';};

/* A folder of photos is the natural way to hand over a place — it is what a
   phone gives you after shooting a room. Sort so the pick is predictable rather
   than filesystem order, and say plainly what happened to the rest. Scan files
   (.ply and friends) are not generation inputs; they belong to the World Viewer,
   so name that instead of silently ignoring them. */
const SCAN_EXT=/\.(ply|splat|spz|ksplat|sog)$/i;
function takeFiles(list){
  const all=[...list];
  if(!all.length)return;
  const imgs=all.filter(f=>f.type.startsWith('image/'))
                .sort((a,b)=>(a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name,undefined,{numeric:true}));
  const scans=all.filter(f=>SCAN_EXT.test(f.name));
  if(imgs.length){
    const room=Math.max(0,8-attachments.length);
    if(!room)glog('✗ Already holding 8 photos — remove one to add another.');
    else{
      addFiles(imgs.slice(0,room));
      if(imgs.length>room)glog('  '+imgs.length+' images found; using the first '+room+'.');
    }
  }
  if(scans.length){
    glog('ℹ '+scans.length+' scan file'+(scans.length>1?'s':'')+' ('+scans[0].name+') — scans are published through the viewer, not generated here. Open the Spatial Engine, press “Open the viewer” and drop the file there.');
  }
  if(!imgs.length&&!scans.length)glog('✗ Nothing usable in that drop — photos (jpg/png) or a folder of them.');
}

/* Dropping a FOLDER gives directory entries rather than files, so walk them. */
async function filesFromDataTransfer(dt){
  const items=[...(dt.items||[])];
  const canWalk=items.length&&typeof items[0].webkitGetAsEntry==='function';
  if(!canWalk)return [...(dt.files||[])];
  const out=[];
  const readDir=entry=>new Promise(res=>{
    const rd=entry.createReader();const acc=[];
    const step=()=>rd.readEntries(es=>{if(!es.length)return res(acc);acc.push(...es);step();},()=>res(acc));
    step();
  });
  const visit=async(entry,depth)=>{
    if(!entry||depth>4)return;
    if(entry.isFile){
      await new Promise(res=>entry.file(f=>{out.push(f);res();},res));
    }else if(entry.isDirectory){
      for(const e of await readDir(entry))await visit(e,depth+1);
    }
  };
  const roots=items.map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);
  for(const r of roots)await visit(r,0);
  return out.length?out:[...(dt.files||[])];
}

/* ---------- composer: one prompt, the engine picked from what you wrote -------
   The four buttons are still there for anyone who wants them, but the primary
   move is now to describe the thing and press Enter. Intent is read from the
   words and DISPLAYED before you send — a router that silently guesses wrong is
   worse than no router, because you pay credits for the wrong engine.
   ---------------------------------------------------------------------------- */
const INTENT_RULES=[
  // Order matters: "3D world" is a world, not an asset; "video of a room" is video.
  {k:'world',re:/\b(world|walk(able|through)?|explore|environment|3d\s*space|space i can|tour of|twin|scan)\b/i,
   label:'a walkable world',btn:'#btnGenWorld'},
  {k:'asset',re:/\b(3d\s*(asset|model|object|prop|mesh)|\bglb\b|\bmesh\b|printable|turntable)\b/i,
   label:'a 3D asset',btn:'#btnGenAsset'},
  {k:'video',re:/\b(video|clip|anima(te|tion)|moving|motion|footage|film|pan|dolly|zoom|cinemagraph|seconds?\b)\b/i,
   label:'a video clip',btn:'#btnGenVid'},
  {k:'image',re:/.*/,label:'an image',btn:'#btnGenImg'},
];
const COST={image:'1 credit',video:'60 credits',asset:'15 credits',world:'150 credits (draft 40)'};
function detectIntent(text){
  const t=(text||'').trim();
  if(!t)return null;
  for(const r of INTENT_RULES)if(r.re.test(t))return r;
  return INTENT_RULES[INTENT_RULES.length-1];
}
function currentIntent(){
  /* getElementById, not $. The stand-in for a missing element answers '' to
     .value, and '' is not 'auto', so this looked up a rule with an empty key,
     found nothing, and every page WITHOUT the selector — which is every page —
     answered Enter with "write what you want first" over a full prompt box.
     Enter is preventDefault-ed, so there was not even a newline to show for
     it. No selector means no override: read the words. */
  const sel=document.getElementById('intentSel');
  const v=sel?sel.value:'auto';
  if(v&&v!=='auto'){
    const picked=INTENT_RULES.find(r=>r.k===v);
    if(picked)return picked;
  }
  return detectIntent($('#genPrompt').value);
}
function updateIntentHint(){
  const el=$('#intentHint');if(!el)return;
  const txt=$('#genPrompt').value.trim();
  const r=currentIntent();
  const refs=attachments.length?attachments.length+' reference'+(attachments.length>1?'s':'')+' attached · ':'';
  if(!txt&&!attachments.length){el.textContent='start typing…';return;}
  if(!r){el.textContent=refs+'describe it and press Enter';return;}
  const auto=$('#intentSel').value==='auto';
  el.textContent=(auto?'reading your prompt as ':'')+r.label+' · '+COST[r.k]
    +(attachments.length?' · '+attachments.length+' reference'+(attachments.length>1?'s':''):'');
}
$('#genPrompt').addEventListener('input',updateIntentHint);
window.__updateIntentHint=updateIntentHint;
window.__detectIntent=detectIntent;
$('#intentSel').addEventListener('change',updateIntentHint);
function sendPromptNow(){
  /* On the Generation page the engine is not guessed from the words — you
     picked it with the switch — so Enter sends to that engine. The intent
     router below is for the pages that still have one prompt box and no
     switch. */
  if(window.__genMode){
    const byMode={image:'#btnGenImg',video:'#btnGenVid',text:'#btnGenText'};
    const el=document.querySelector(byMode[window.__genMode]||'#btnGenImg');
    if(el){el.click();return;}
  }
  const r=currentIntent();
  if(!r){glog('✗ Write what you want first — or attach a photo and describe the change.');return;}
  const btn=$(r.btn);
  if(!btn){glog('✗ That engine is not available.');return;}
  glog('▸ '+r.label.replace(/^an? /,'')+' — sending…');
  btn.click();
}
$('#btnSend').onclick=sendPromptNow;
// Enter sends, Shift+Enter makes a new line — the convention every chat box uses.
$('#genPrompt').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendPromptNow();}
  else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();sendPromptNow();}
});

/* Drag a file anywhere onto the page to attach it, and paste from the clipboard.
   dragenter/dragleave fire for every child element, so the veil is reference
   counted — otherwise it flickers off the moment the cursor crosses a border. */
(function dropAnywhere(){
  const veil=document.createElement('div');
  veil.id='dropVeil';
  veil.innerHTML='<div class="card"><h3>Drop to attach</h3><p>Photos or a whole folder of them — the first four become the reference for what you make next.</p></div>';
  document.body.appendChild(veil);
  let depth=0;
  const hasFiles=e=>e.dataTransfer&&[...(e.dataTransfer.types||[])].includes('Files');
  addEventListener('dragenter',e=>{if(!hasFiles(e))return;e.preventDefault();depth++;veil.classList.add('on');});
  addEventListener('dragover',e=>{if(hasFiles(e))e.preventDefault();});
  addEventListener('dragleave',e=>{if(!hasFiles(e))return;depth=Math.max(0,depth-1);if(!depth)veil.classList.remove('on');});
  addEventListener('drop',async e=>{
    if(!hasFiles(e))return;
    e.preventDefault();depth=0;veil.classList.remove('on');
    const files=await filesFromDataTransfer(e.dataTransfer);
    takeFiles(files);
    const box=$('#genPrompt');if(box)box.focus();
  });
  addEventListener('paste',e=>{
    const items=[...((e.clipboardData&&e.clipboardData.files)||[])].filter(f=>f.type.startsWith('image/'));
    if(items.length){addFiles(items);glog('+ Pasted '+items.length+' image'+(items.length>1?'s':''));}
  });
})();
/* getElementById, not $ — $ hands back an inert stand-in for anything the
   current page doesn't have, and that stand-in is truthy. Asking it for
   .value returns '' and every `genMode()==='backend'` check would fail,
   quietly routing generation down the bring-your-own-key path. */
const genMode=()=>'backend';
/* A job that went to the M3XI render box instead of a cloud provider. The
   backend answers {queued:true, job_id}; poll until the worker has finished.
   Video on one GPU takes minutes; images seconds. */
async function awaitLocal(q,kind){
  glog('  '+(q.message||'Queued on the M3XI render box.'));
  const limit=kind==='video'?360:120;            // × 5 s → 30 min / 10 min
  for(let i=0;i<limit;i++){
    await new Promise(x=>setTimeout(x,5000));
    const st=await backendCall({action:'job_status',job_id:q.job_id});
    if(st.status==='done')return st.output&&st.output.url;
    if(st.status==='failed')throw new Error('The render box failed on this one — credits were refunded. '+(st.error||''));
    if(i%12===11)glog('   still '+(st.status==='running'?'rendering':'waiting for the render box')+' … ('+Math.round((i+1)*5/60)+' min)');
  }
  throw new Error('Still in the queue — it will finish when the render box is on. Check your Library later.');
}
$('#genMode').onchange=()=>{$('#directBox').style.display=genMode()==='direct'?'':'none';};

/* credits — the two code fields stay in sync */
const codeFields=['creditCode','creditCode2'].map(id=>document.getElementById(id)).filter(Boolean);
codeFields.forEach(f=>f.addEventListener('input',()=>codeFields.forEach(o=>{if(o!==f)o.value=f.value;})));
const _savedCode=localStorage.getItem('m3ix_code')||'';
if(_savedCode)codeFields.forEach(f=>f.value=_savedCode);
codeFields.forEach(f=>f.addEventListener('input',()=>localStorage.setItem('m3ix_code',f.value.trim())));
async function refreshCredits(){
  const el=document.getElementById('topCreditsN');if(!el)return;
  const c=($('#creditCode').value||'').trim();
  if(!c){el.textContent='—';return;}
  try{const b=await backendCall({action:'balance',code:c.toUpperCase()});el.textContent=Number(b.remaining).toLocaleString();}catch(e){el.textContent='—';}
}
const _tc=document.getElementById('topCredits');if(_tc)_tc.onclick=()=>{location.hash='#plans';};
setTimeout(refreshCredits,600);
codeFields.forEach(f=>f.addEventListener('change',refreshCredits));
/* pricing.html names its field creditCode2 (the page used to have two), so
   reading only #creditCode meant Check balance there always answered "Enter a
   code first" however long the code you pasted. Read whichever this page has. */
const creditCode=()=>{
  const a=document.getElementById('creditCode'),b=document.getElementById('creditCode2');
  return String((a&&a.value)||(b&&b.value)||'').trim().toUpperCase();
};
async function checkBal(msgEl){
  if(!creditCode())return msgEl.textContent='Enter a code first.';
  try{const b=await backendCall({action:'balance',code:creditCode()});
    msgEl.textContent=b.remaining+' credits left (of '+b.total+')';
  }catch(e){msgEl.textContent=e.message;}
}
$('#btnCheckBal').onclick=()=>checkBal($('#balMsg'));
$('#btnCheckBal2').onclick=()=>checkBal($('#balMsg2'));
$$('[data-pack]').forEach(btn=>btn.onclick=async()=>{
  try{glog('Opening secure checkout …');
    // Send the SIGNED-IN user's token when there is one, so Stripe carries their
    // id and the credits land on their account instead of becoming a code they
    // have to keep. Signed out still works — it just falls back to a code.
    let auth=M3IX_BACKEND.key,who='';
    try{
      const sb=window.__sb;
      if(sb){
        const{data:{session}}=await sb.auth.getSession();
        if(session&&session.access_token){auth=session.access_token;who=' to your account';}
      }
    }catch(e){}
    const r=await fetch(M3IX_BACKEND.fn.replace('m3ix-generate','m3ix-checkout'),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+auth,'apikey':M3IX_BACKEND.key},body:JSON.stringify({pack:btn.dataset.pack})});
    const j=await r.json();if(!r.ok||j.error)throw new Error(j.error||('HTTP '+r.status));
    glog(j.to_account
      ? 'Checkout opened in a new tab — credits are added'+who+' as soon as payment clears.'
      : 'Checkout opened in a new tab. You are signed out, so a credit code appears after payment — sign in first and it goes straight onto your account instead.');
    window.open(j.url,'_blank');
  }catch(e){glog('✗ '+e.message);}
});

// Coming back from a successful payment: say so, and refresh the balance.
(function(){
  const paid=new URLSearchParams(location.search).get('paid');
  if(!paid)return;
  const msg=document.querySelector('#acctMsg2');
  if(msg){msg.textContent=Number(paid).toLocaleString()+' credits added. Thank you.';}
  setTimeout(()=>{try{window.__refreshAccount&&window.__refreshAccount();}catch(e){}},400);
})();

$('#btnGenWorld').onclick=genWorld;
$('#btnGenImg').onclick=async()=>{
  let p=$('#genPrompt').value.trim();if(!p)return glog('✗ Write a prompt first.');
  try{
    const ref=attachments[0],ep=ref?$('#epImgI2I').value:$('#epImgT2I').value;
    p=await maybeRefine(p,'image');
    glog(ref?'Creating your image from "'+ref.name+'" …':'Creating your image …');
    if(attachments.length>1)glog('  note: this model takes one reference — using the first attachment.');
    let url;
    if(genMode()==='backend'){
      const j=await backendCall({action:'image',prompt:p,image_url:ref?ref.url:undefined,portrait:imgPortrait,code:creditCode()||undefined});
      if(j.credits_remaining!=null)glog('  credits left: '+j.credits_remaining);
      url=j.queued?await awaitLocal(j,'image'):j.url;
    }else{
      const body=ref?{prompt:p,image_url:ref.url,strength:0.82}:{prompt:p,image_size:imgPortrait?'portrait_16_9':'landscape_16_9',num_images:1};
      const r=await fetch('https://fal.run/'+ep,{method:'POST',headers:falHeaders(),body:JSON.stringify(body)});
      if(!r.ok)throw new Error('HTTP '+r.status+' — check key/endpoint ('+(await r.text()).slice(0,140)+')');
      const j=await r.json();url=(j.images&&j.images[0]&&j.images[0].url)||j.image?.url;
    }
    if(!url)throw new Error('No image in response');
    glog('✓ Image ready.');lastImageUrl=url;
    let shown=false;
    if(genMode()==='backend'){
      try{const a=await backendCall({action:'fetch_asset',url:url});
        $('#genOut').innerHTML='<img src="'+a.dataUri+'" alt="generated">';shown=true;
      }catch(_){glog('  note: inline preview blocked here — use Open full size.');}
    }
    if(!shown)$('#genOut').innerHTML='<img src="'+url+'" alt="generated">';
    $('#genOut').appendChild(imageActions(url));
    const gi=$('#genOut img');
    if(gi){gi.style.cursor='zoom-in';gi.title='Click to view full screen';gi.onclick=()=>lbShow(gi.src,'Generated in M3XI Studio');}
  }catch(e){glog('✗ '+e.message);}
};

/* ===================== WORDS ================================================
   The third engine. It writes rather than renders, so it costs a fraction of
   the others, never reaches the Editor and never reaches the Library — it
   lands in the output panel with a Copy button, which is all anyone wants
   from a listing description or a caption.
   ============================================================================ */
const TEXT_BRIEF={
  free:'You are a sharp, plain-spoken writer. Answer the request directly. No preamble, no sign-off, no markdown headings.',
  listing:'You write UK property listing copy for an estate agent. Warm, factual, specific, British spelling. Never invent a measurement, a price, a tenure, a council-tax band, an EPC rating or a nearby school — if the writer did not give you a fact, leave it out rather than guessing. No exclamation marks. 120 to 180 words.',
  script:'You write short video scripts. Give the spoken words only, in short lines a person can actually say out loud, with a bracketed note for anything that must appear on screen. Open on the strongest idea, never on a greeting. Keep it to the length asked for, or 30 seconds if none was given.',
  caption:'You write social captions. Give five options, one per line, numbered. Each under 140 characters, plain, specific and free of hype. No hashtag walls: at most three, only if they are genuinely useful.',
  shots:'You write shot lists. One shot per line, each a self-contained visual description under 40 words, in chronological order, no numbering and no commentary. Between three and eight lines.',
};
$('#btnGenText').onclick=async()=>{
  let p=$('#genPrompt').value.trim();
  if(!p)return glog('✗ Write what you want first.');
  const kind=($('#textKind').value||'free');
  try{
    p=await maybeRefine(p,'text');
    glog('Writing …');
    const j=await backendCall({action:'refine',code:creditCode()||undefined,
      system:TEXT_BRIEF[kind]||TEXT_BRIEF.free,prompt:p});
    const out=String(j.output||'').trim();
    if(!out)throw new Error('The language model returned nothing.');
    if(j.credits_remaining!=null)glog('  credits left: '+j.credits_remaining);
    glog('✓ Written.');
    const box=document.createElement('div');
    const pre=document.createElement('pre');
    pre.className='textOut';pre.textContent=out;
    const row=document.createElement('div');row.className='srow';
    const copy=document.createElement('button');
    copy.className='btn sm';copy.textContent='Copy';
    copy.onclick=async()=>{
      try{await navigator.clipboard.writeText(out);copy.textContent='Copied';}
      catch(_){const r=document.createRange();r.selectNodeContents(pre);
        const s=getSelection();s.removeAllRanges();s.addRange(r);copy.textContent='Select and copy';}
      setTimeout(()=>{copy.textContent='Copy';},1600);
    };
    const again=document.createElement('button');
    again.className='btn sm ghost';again.textContent='Write another';
    again.onclick=()=>document.getElementById('btnGenText').click();
    row.appendChild(copy);row.appendChild(again);
    box.appendChild(pre);box.appendChild(row);
    $('#genOut').innerHTML='';$('#genOut').appendChild(box);
  }catch(e){glog('✗ '+e.message);}
};
$('#btnGenVid').onclick=async()=>{
  let p=$('#genPrompt').value.trim();if(!p)return glog('✗ Write a prompt first.');
  try{
    const ref=attachments[0],ep=ref?$('#epVidI2V').value:$('#epVidT2V').value;
    p=await maybeRefine(p,'video');
    glog(ref?'Bringing "'+ref.name+'" to life — usually 1–3 minutes …':'Creating your video — usually 1–3 minutes …');
    let su,ru,st,resp,url;
    if(genMode()==='backend'){
      const q=await backendCall({action:'video_submit',prompt:p,image_url:ref?ref.url:undefined,aspect:vidAspect,duration:vidDur,code:creditCode()||undefined});
      if(q.credits_remaining!=null)glog('  credits left: '+q.credits_remaining);
      if(q.queued){url=await awaitLocal(q,'video');resp={video:{url}};}
      su=q.status_url;ru=q.response_url;
      if(!q.queued){
      for(let i=0;i<80;i++){
        await new Promise(x=>setTimeout(x,3500));
        st=await backendCall({action:'video_status',url:su});
        if(i%8===0&&i>0)glog('   still rendering … ('+Math.round(i*3.5)+'s)');
        if(st.status==='COMPLETED')break;
        if(st.status==='FAILED'||st.status==='ERROR')throw new Error('Generation failed on provider side.');
      }
      if(!st||st.status!=='COMPLETED')throw new Error('Timed out — it may still finish; check again shortly.');
      resp=await backendCall({action:'video_result',url:ru});
      }
    }else{
      const body=ref?{prompt:p,image_url:ref.url,duration:vidDur}:{prompt:p,duration:vidDur,aspect_ratio:vidAspect};
      const r=await fetch('https://queue.fal.run/'+ep,{method:'POST',headers:falHeaders(),body:JSON.stringify(body)});
      if(!r.ok)throw new Error('HTTP '+r.status+' — check key/endpoint ('+(await r.text()).slice(0,140)+')');
      const q=await r.json();su=q.status_url;ru=q.response_url;
      for(let i=0;i<80;i++){
        await new Promise(x=>setTimeout(x,3500));
        st=await(await fetch(su,{headers:falHeaders()})).json();
        if(i%8===0&&i>0)glog('   still rendering … ('+Math.round(i*3.5)+'s)');
        if(st.status==='COMPLETED')break;
        if(st.status==='FAILED'||st.status==='ERROR')throw new Error('Generation failed on provider side.');
      }
      if(!st||st.status!=='COMPLETED')throw new Error('Timed out — check your fal dashboard, it may still finish.');
      resp=await(await fetch(ru,{headers:falHeaders()})).json();
    }
    url=resp.video?.url||(resp.videos&&resp.videos[0]&&resp.videos[0].url);
    if(!url)throw new Error('No video in response');
    glog('✓ Video ready.');
    $('#genOut').innerHTML='<video src="'+url+'" controls autoplay muted loop playsinline></video>';
    $('#genOut').appendChild(videoActions(url,p));
    lastVideoUrl=url;
  }catch(e){glog('✗ '+e.message);}
};
async function oneClip(prompt){
  const q=await backendCall({action:'video_submit',prompt,aspect:vidAspect,duration:vidDur,code:creditCode()||undefined});
  if(q.queued)return await awaitLocal(q,'video');
  let st=null;
  for(let i=0;i<80;i++){
    await new Promise(x=>setTimeout(x,3500));
    st=await backendCall({action:'video_status',url:q.status_url});
    if(st.status==='COMPLETED')break;
    if(st.status==='FAILED'||st.status==='ERROR')throw new Error('The provider failed on this scene — the remaining scenes were not charged.');
  }
  if(!st||st.status!=='COMPLETED')throw new Error('Scene timed out — it may still finish; retry shortly.');
  const resp=await backendCall({action:'video_result',url:q.response_url});
  return resp.video?.url||(resp.videos&&resp.videos[0]&&resp.videos[0].url);
}
async function refineFilmScenes(){
  const c=$('#filmConcept').value.trim();
  if(!c)return glog('Write the film concept first.');
  const b=$('#btnRefineFilm');b.classList.add('red');
  try{
    glog('Writing your shot list …');
    const j=await backendCall({action:'refine',code:creditCode()||undefined,
      system:'You are a film director. Turn the concept into a chronological shot list of 3 to 8 scenes. Output ONLY the scenes, one per line, each a vivid self-contained visual prompt under 40 words. No numbering, no commentary.',
      prompt:c});
    $('#filmScenes').value=String(j.output||'').trim();
    glog('Shot list ready — edit any line, then generate.');
  }catch(e){glog('✗ '+e.message);}
  b.classList.remove('red');
}
async function makeFilm(maxScenes){
  if(genMode()!=='backend')return glog('Films run through M3XI Cloud — switch Mode back under Advanced.');
  const lines=$('#filmScenes').value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,maxScenes);
  if(!lines.length)return glog('Add scenes first — one per line, or press Refine.');
  const style=' Consistent cinematic look across the whole film: same colour grade, 35mm, natural light.';
  glog('Making your '+(maxScenes>3?'long':'short')+' film — '+lines.length+' scene'+(lines.length>1?'s':'')+', rendered in order …');
  $('#genOut').innerHTML='';
  const made=[];
  for(let i=0;i<lines.length;i++){
    glog('Scene '+(i+1)+' of '+lines.length+' …');
    const url=await oneClip(lines[i]+style);
    made.push({url,name:'Scene '+(i+1),kind:'video'});
    const d=document.createElement('div');
    d.innerHTML='<p class="price-note" style="margin:10px 0 2px"><b>Scene '+(i+1)+'</b> — '+lines[i].slice(0,80).replace(/</g,'&lt;')+'</p>';
    const v=document.createElement('video');v.src=url;v.controls=true;v.muted=true;v.loop=true;v.playsInline=true;
    d.appendChild(v);
    $('#genOut').appendChild(d);
  }
  // Scenes used to stop here, as separate files with a note saying stitching
  // was coming. It came: they go straight onto a timeline, in order.
  const row=document.createElement('div');row.className='srow';row.style.marginTop='12px';
  const b=document.createElement('button');b.className='btn red';b.textContent='Cut this film in the Editor';
  b.onclick=()=>sendToEditor(made);
  row.appendChild(b);
  const n=document.createElement('span');n.className='small';n.textContent='All '+made.length+' scenes land on one timeline, in order.';
  row.appendChild(n);
  $('#genOut').appendChild(row);
  glog('Film complete — '+made.length+' scenes, in order. Send them to the Editor to cut, score and export as one video.');
}
$('#btnRefineFilm').onclick=refineFilmScenes;
$('#btnFilmShort').onclick=()=>makeFilm(3).catch(e=>glog('✗ '+e.message));
$('#btnFilmLong').onclick=()=>makeFilm(8).catch(e=>glog('✗ '+e.message));
$('#btnGenAsset').onclick=async()=>{
  const ref=attachments[0]?attachments[0].url:lastImageUrl;
  if(!ref)return glog('✗ 3D assets are built from an image — attach one or generate one first.');
  if(genMode()!=='backend')return glog('✗ 3D assets run through M3XI Cloud — switch Mode back under Advanced.');
  try{
    glog('Building your 3D asset — usually 1–3 minutes …');
    const q=await backendCall({action:'asset_submit',image_url:ref,code:creditCode()||undefined});
    if(q.credits_remaining!=null)glog('  credits left: '+q.credits_remaining);
    let st;
    for(let i=0;i<70;i++){
      await new Promise(x=>setTimeout(x,4000));
      st=await backendCall({action:'video_status',url:q.status_url});
      if(i%6===0&&i>0)glog('   still building … ('+Math.round(i*4)+'s)');
      if(st.status==='COMPLETED')break;
      if(st.status==='FAILED'||st.status==='ERROR')throw new Error('3D generation failed on provider side.');
    }
    if(!st||st.status!=='COMPLETED')throw new Error('Timed out — it may still finish; try again shortly.');
    const resp=await backendCall({action:'video_result',url:q.response_url});
    const glb=(resp.model_glb&&resp.model_glb.url)||(resp.model_urls&&resp.model_urls.glb&&resp.model_urls.glb.url);
    if(!glb)throw new Error('No 3D model in response');
    glog('✓ 3D asset ready — drag to inspect. Place it in a world from the World Viewer.');
    if(!window.__mvLoaded){window.__mvLoaded=true;const s=document.createElement('script');s.type='module';s.src='https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js';document.head.appendChild(s);}
    $('#genOut').innerHTML='<model-viewer src="'+glb+'" camera-controls auto-rotate shadow-intensity="1" style="width:100%;height:400px;background:#e9e6da"></model-viewer><div class="srow"><a class="btn sm ghost" href="'+glb+'" target="_blank" rel="noopener" download>Download GLB</a></div>';
  }catch(e){glog('✗ '+e.message);}
};

/* the button you press glows red while it works */
['btnGenImg','btnGenVid','btnGenText','btnGenAsset','btnGenWorld','btnFilmShort','btnFilmLong'].forEach(id=>{
  const el=document.getElementById(id);if(!el||!el.onclick)return;
  const orig=el.onclick;
  el.onclick=async e=>{el.classList.add('red');try{await orig.call(el,e);}finally{if(id!=='btnGenImg')el.classList.remove('red');}};
});

/* reveal-on-scroll: classes are added by JS only, so with no JS everything stays visible */
(function(){
  try{
    if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    if(!('IntersectionObserver' in window))return;
    var SEL='.sechead,.subline,.filters,.piece,.panel,.step,.wcard,.pack,.rcard,.costRow,.balRow,.libEmpty,.heroCopy > *,.hp,.heroNote';
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
    },{rootMargin:'0px 0px -6% 0px',threshold:0.06});
    var n=0;
    function scan(){
      var els=document.querySelectorAll(SEL);
      for(var i=0;i<els.length;i++){
        var el=els[i];
        if(el.dataset.rv)continue;
        el.dataset.rv='1';
        var t='';
        try{t=getComputedStyle(el).transform;}catch(_){}
        el.classList.add('rv');
        if(!t||t==='none')el.classList.add('mv');      /* rotated panels fade only, keeping their tilt */
        el.style.transitionDelay=((n++%5)*70)+'ms';
        io.observe(el);
      }
    }
    scan();
    addEventListener('load',scan);
    setTimeout(scan,800);setTimeout(scan,2400);setTimeout(scan,5000);
    window.__reveal=scan;
    if(location.protocol==='file:'){
      var m2={'ugc.html':'../public/studio/ugc.html','walkthrough.html':'../public/studio/walkthrough.html'};
      document.querySelectorAll('a[href]').forEach(function(a){
        var h=a.getAttribute('href'),b=h.split('?')[0].split('#')[0];
        if(m2[b])a.setAttribute('href',m2[b]+h.slice(b.length));
      });
    }
  }catch(_){}
})();

/* ---------- accounts ----------------------------------------------------------
   Passwordless on purpose. A magic link means no password is chosen, stored,
   reset or leaked here, and it sidesteps the whole class of problems that comes
   with holding credentials for a product that also holds money.

   Nothing on this page can change a balance. The client may READ its own balance
   and call redeem; every credit movement is written server-side against an
   append-only ledger, so a tampered page cannot mint credits.
   ---------------------------------------------------------------------------- */
// jsdelivr rather than esm.sh: the viewer already loads three.js from jsdelivr
// on this site, so it is the CDN known to be reachable here.

/* CANONICAL ORIGIN. m3xi.com 307-redirects to www.m3xi.com, and that redirect
   lands in the middle of the sign-in round trip. Supabase's PKCE flow stores a
   code verifier in localStorage before leaving for Google and reads it back on
   return — but localStorage is per-ORIGIN, so a verifier written under
   https://m3xi.com cannot be read under https://www.m3xi.com. The exchange then
   fails with nothing to show for it and the visitor lands looking signed out,
   which is exactly the symptom: sign in, come back, still signed out, credits
   never load. Starting and finishing on the same canonical origin fixes it. */
function canonicalOrigin(){
  try{
    if(location.hostname==='m3xi.com')return 'https://www.m3xi.com';
  }catch(e){}
  return location.origin;
}
/* NO FRAGMENT in the return URL — ever. Sign-in comes back with the session in
   a fragment of its own (#access_token=…), and appending that to a URL that
   already ends in #account produced /studio/#account#access_token=…, which the
   client cannot parse. The session was created server-side and then dropped on
   the floor client-side: sign in, come back, still "Sign in". Seven orphaned
   sessions on one account before anyone caught it. The panel intent rides in a
   query parameter instead, and the page scrolls itself once signed in. */
function returnUrl(){ return canonicalOrigin()+location.pathname+'?panel=account'; }

/* Rescue links from emails sent BEFORE the fix (and any bookmark of one): if
   the hash is the collided form  #account#access_token=…, rewrite it to the
   clean form before the client looks at the URL, so those still sign in. */
(function rescueCollidedFragment(){
  try{
    const h=location.hash||'';
    const i=h.indexOf('#',1);
    if(i>0&&(h.slice(i+1,i+14)==='access_token='||h.slice(i+1,i+7)==='error=')){
      history.replaceState(null,'',location.pathname+location.search+'#'+h.slice(i+1));
    }
  }catch(e){}
})();
const SB_URL='https://tnlcuptfldwxtxajudoq.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRubGN1cHRmbGR3eHR4YWp1ZG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODcxNDEsImV4cCI6MjEwMDA2MzE0MX0.mgS1gDa7qeBsTCaXmefpogg02kw7tCzn0uEYPAAuC90';
/* NO cross-tab auth locks. supabase-js serialises auth work through
   navigator.locks by default — and when Chrome freezes a background tab that
   holds the lock (a WebGL world viewer tab qualifies within minutes), every
   other m3xi.com tab queues behind it FOREVER. getSession never resolves, the
   page paints its signed-out default, and a perfectly valid session sits in
   storage unreachable: "signed in, reloaded, signed out again". Observed live:
   one holder, seven waiters. A per-page serial queue keeps writes ordered
   within the tab, and the server's refresh-token reuse window absorbs the rare
   cross-tab refresh race. */
/* And no in-page queue either: the client re-enters the lock during its own
   initialisation (a queued op awaiting an op queued behind it), so a serial
   queue deadlocks against itself. A plain passthrough is exactly what
   supabase-js runs on browsers without navigator.locks — years of production
   use, and refresh races are absorbed by the server's reuse window. */
const tabLock=(_name,_timeout,fn)=>fn();
/* A stand-in with the same shape, so every `await sb.auth.getSession()` in this
   file answers "signed out" instead of throwing. */
function offlineClient(){
  const none = async () => ({ data: { session: null, user: null }, error: new Error('Accounts are offline') });
  return {
    auth: {
      getSession: none, getUser: none, signInWithOtp: none, signInWithOAuth: none,
      verifyOtp: none, signOut: none, updateUser: none,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
    },
    from: () => ({ select: none, insert: none, update: none, upsert: none, delete: none }),
    rpc: none,
    storage: { from: () => ({ upload: none, getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
  };
}
let sb = offlineClient();          // let, not const: upgraded in place below.
/* Everything that talks to the account waits for this. Generation pages simply
   behave as signed-out until it resolves, which is the truth anyway. */
const sbReady = import(/* @vite-ignore */ SB_CDN)
  .then(m => {
    sb = m.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,lock:tabLock}});
    window.__sb = sb;
    return sb;
  })
  .catch(e => {
    console.warn('M3XI: accounts unavailable — could not load the auth client.', e);
    return sb;
  });
/* $ is already defined once at the top of this file — the module block used to
   be a separate <script> with its own copy. */
const say=(el,t,bad)=>{const e=$(el);if(e){e.textContent=t;e.style.color=bad?'var(--red)':'';}};

/* Initials from the email — two letters where the address gives two. It is the
   cheapest way to see WHICH account you are working in, and that matters now
   that the work and the credits are personal. */
function initialsFor(email,meta){
  const name=(meta&&(meta.full_name||meta.name))||'';
  if(name.trim()){
    const p=name.trim().split(/\s+/);
    return ((p[0][0]||'')+(p.length>1?p[p.length-1][0]:'')).toUpperCase();
  }
  const local=String(email||'').split('@')[0]||'';
  const parts=local.split(/[._\-+]/).filter(Boolean);
  if(parts.length>1)return (parts[0][0]+parts[1][0]).toUpperCase();
  return local.slice(0,2).toUpperCase()||'M3';
}
window.__initialsFor=initialsFor;
const AVATARS=['◆','▲','●','✦','■','✦️','⚙','♟','☁','☀','☽','⚑'];
function paintAvatars(chosen){
  const box=$('#avatarPick');if(!box)return;
  box.innerHTML='';
  AVATARS.forEach(a=>{
    const b=document.createElement('button');
    b.type='button';b.textContent=a;b.className=(a===chosen?'on':'');
    b.onclick=()=>{paintAvatars(a);box.dataset.pick=a;};
    box.appendChild(b);
  });
  box.dataset.pick=chosen||box.dataset.pick||'';
}
function meter(barSel,txtSel,used,cap,unit){
  const pct=cap>0?Math.min(100,Math.round(used/cap*100)):0;
  const bar=$(barSel),txt=$(txtSel);
  if(bar){bar.style.width=pct+'%';bar.parentElement.classList.toggle('warn',pct>=80);}
  if(txt)txt.textContent=Math.round(used).toLocaleString()+' of '+Math.round(cap).toLocaleString()+' '+unit+
    (pct>=100?' — limit reached, it frees up as the window rolls':pct>=80?' — close to the limit':'');
}

async function refreshAccount(){
  const{data:{session}}=await sb.auth.getSession();
  const inEl=$('#acctSignedIn'),outEl=$('#acctSignedOut');
  const authBtn=$('#btnAuth'),profBtn=$('#btnProfile');
  if(!session){
    if(inEl)inEl.style.display='none';
    if(outEl)outEl.style.display='';
    /* #account is a section on account.html and nowhere else, so this quietly
       turned the only sign-in button into a dead link on every other page. */
    if(authBtn){authBtn.textContent='Sign in';authBtn.dataset.mode='in';authBtn.href='account.html';}
    if(profBtn)profBtn.style.display='none';
    const ch=$('#avatarChip');if(ch)ch.style.display='none';
    const w=$('#acctWorkList');if(w)w.innerHTML='<p class="price-note">Sign in to see the worlds you have made.</p>';
    renderLibrary();
    return;
  }
  if(inEl)inEl.style.display='';
  if(outEl)outEl.style.display='none';
  // Signed in: the nav button becomes Sign out and actually signs you out.
  if(authBtn){authBtn.textContent='Sign out';authBtn.dataset.mode='out';authBtn.removeAttribute('href');authBtn.style.cursor='pointer';}
  if(profBtn)profBtn.style.display='';

  const m=session.user.user_metadata||{};
  const who=m.full_name||m.name||session.user.email||'signed in';
  const ch=$('#avatarChip');
  if(ch){ch.textContent=initialsFor(session.user.email,m);ch.title=session.user.email||'';ch.style.display='inline-flex';}
  say('#acctWho',who+(m.full_name&&session.user.email?' · '+session.user.email:''));

  try{
    const{data,error}=await sb.rpc('m3ix_usage_status');
    if(!error&&data){
      say('#acctBal',Number(data.balance||0).toLocaleString());
      if(authBtn)authBtn.title=Number(data.balance||0).toLocaleString()+' credits';
      if(profBtn)profBtn.textContent=Number(data.balance||0).toLocaleString()+' credits';
      meter('#barHour','#txtHour',Number(data.hour_used||0),Number(data.hour_cap||0),'this hour');
      meter('#barWeek','#txtWeek',Number(data.week_used||0),Number(data.week_cap||0),'this week');
      if(document.getElementById('pfUser')&&!$('#pfUser').value)$('#pfUser').value=data.username||'';
      const soc=data.socials||{};
      if(document.getElementById('pfIG')&&!$('#pfIG').value)$('#pfIG').value=soc.instagram||'';
      if(document.getElementById('pfSite')&&!$('#pfSite').value)$('#pfSite').value=soc.site||'';
      paintAvatars(data.avatar||AVATARS[0]);
    }
  }catch(e){}
  loadMyWork();
  renderLibrary();
  claimRefIfAny().then(paintReferral);
  paintSocial();paintQueue();
}

async function loadMyWork(){
  const el=$('#acctWorkList');if(!el)return;
  try{
    const{data,error}=await sb.from('m3ix_spaces')
      .select('embed_slug,title,status,created_at')
      .order('created_at',{ascending:false}).limit(24);
    if(error)throw error;
    if(!data||!data.length){
      el.innerHTML='<p class="price-note">Nothing yet — build a walkthrough in the Spatial Engine and it lands here.</p>';return;
    }
    el.innerHTML='<div class="libGrid">'+data.map(w=>{
      const url='walkthrough.html?world='+encodeURIComponent(w.embed_slug);
      const live=w.status==='published';
      return '<div class="panel wcard"><div class="meta">'+
        '<span class="nm">'+String(w.title||'Untitled').replace(/[<>&]/g,'')+'</span>'+
        '<span class="chip'+(live?'':' dev')+'"><span class="dot"></span>'+(live?'live':'draft')+'</span>'+
        '<a class="btn sm ghost" href="'+url+'" target="_blank" rel="noopener">Walk</a></div></div>';
    }).join('')+'</div>';
  }catch(e){el.innerHTML='<p class="price-note">Could not load your work — '+String(e.message||e)+'</p>';}
}

$('#btnSignIn')&&($('#btnSignIn').onclick=async()=>{
  const email=($('#acctEmail')&&$('#acctEmail').value||'').trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return say('#acctMsg','That does not look like an email address.',true);
  say('#acctMsg','Sending…');
  const{error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:returnUrl()}});
  say('#acctMsg',error?('Could not send: '+error.message):'Check your inbox — the link signs you straight in.',!!error);
});
/* Google is configured on the Supabase project already, so this only has to ask
   for it. redirectTo must be listed in Supabase → Authentication → URL
   Configuration, otherwise Google returns the user to a refused redirect. */
$('#btnGoogle')&&($('#btnGoogle').onclick=async()=>{
  say('#acctMsg','Opening Google…');
  const{error}=await sb.auth.signInWithOAuth({
    provider:'google',
    options:{
      redirectTo:returnUrl(),
      queryParams:{prompt:'select_account'}   // never silently reuse a signed-in Google account
    }
  });
  if(error)say('#acctMsg','Google sign-in failed: '+error.message,true);
});
$('#btnSignOut')&&($('#btnSignOut').onclick=async()=>{await sb.auth.signOut();refreshAccount();});
$('#btnAuth')&&($('#btnAuth').onclick=async e=>{
  if(e.currentTarget.dataset.mode!=='out')return;      // signed out: just a link to the panel
  e.preventDefault();
  await sb.auth.signOut();
  refreshAccount();
});
$('#btnSaveProfile')&&($('#btnSaveProfile').onclick=async()=>{
  const{data:{session}}=await sb.auth.getSession();
  if(!session)return say('#pfMsg','Sign in first.',true);
  const uname=($('#pfUser').value||'').trim().toLowerCase();
  if(uname&&!/^[a-z0-9][a-z0-9_.]{2,23}$/.test(uname))
    return say('#pfMsg','3–24 characters: letters, numbers, dot or underscore.',true);
  say('#pfMsg','Saving…');
  const{error}=await sb.from('m3ix_accounts').update({
    username:uname||null,
    avatar:$('#avatarPick').dataset.pick||null,
    socials:{instagram:($('#pfIG').value||'').trim(),site:($('#pfSite').value||'').trim()}
  }).eq('user_id',session.user.id);
  if(error)return say('#pfMsg',/duplicate|unique/i.test(error.message)?'That username is taken.':error.message,true);
  say('#pfMsg','Saved.');
  renderLibrary();
});
$('#btnRedeem')&&($('#btnRedeem').onclick=async()=>{
  const code=($('#acctCode')&&$('#acctCode').value||'').trim();
  if(!code)return say('#acctMsg2','Paste a code first.',true);
  say('#acctMsg2','Redeeming…');
  const{data,error}=await sb.rpc('m3ix_redeem_code',{p_code:code});
  if(error)return say('#acctMsg2',error.message||'That code could not be redeemed.',true);
  $('#acctCode').value='';
  say('#acctMsg2','Added. New balance: '+Number(data).toLocaleString()+' credits.');
  refreshAccount();
});
window.__refreshAccount=refreshAccount;
paintAvatars(AVATARS[0]);
/* ---------- the Library, with likes -------------------------------------------
   Rendered from m3ix_library, which returns the like count, whether YOU have
   liked it, and the maker's handle in one call — rather than a query per card.
   Liking is optimistic: the count moves the instant you press it, because
   waiting on a round trip to see your own tap register feels broken. If the
   write fails it is put back.
   ---------------------------------------------------------------------------- */
async function renderLibrary(){
  const grid=$('#libGrid'),empty=$('#libEmpty');
  if(!grid)return;
  try{
    const{data,error}=await sb.rpc('m3ix_library',{p_limit:48});
    if(error)throw error;
    const ws=data||[];
    if(!ws.length){if(empty)empty.style.display='';return;}
    if(empty)empty.style.display='none';
    const esc=t=>String(t==null?'':t).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    grid.innerHTML='';
    ws.forEach((w,i)=>{
      const url='walkthrough.html?world='+encodeURIComponent(w.slug)+'&embed=1';
      const d=document.createElement('div');
      d.className='panel wcard'+(i%3===1?' tilt-r':i%3===2?' tilt-l':'');
      const by=w.username?('@'+esc(w.username)):'M3XI Spatial';
      /* A maker's own website comes out of their profile, which they type.
         Putting it straight into an href let anyone publish a world whose
         byline ran javascript: in every visitor's browser — stored, on the
         Library, on the front of the Studio. Only http and https ever become
         a link; anything else is shown as text. */
      const safeHref=u=>{
        try{const p=new URL(String(u),location.origin);return /^https?:$/.test(p.protocol)?p.href:'';}
        catch(_){return '';}
      };
      const socHref=w.socials&&w.socials.instagram
        ? 'https://instagram.com/'+encodeURIComponent(String(w.socials.instagram).replace(/^@/,''))
        : safeHref((w.socials&&w.socials.site)||'');
      d.innerHTML=
        '<a class="cov" href="'+url+'" target="_blank" rel="noopener">'+
          (w.cover?'<img loading="lazy" src="'+esc(w.cover)+'" alt="">':'<span class="ph">三X一</span>')+
          (w.source==='marble'?'<span class="aiBadge">AI-generated</span>':'')+
        '</a>'+
        '<div class="meta">'+
          '<span class="nm">'+esc(w.title||'Untitled')+'</span>'+
          (socHref?'<a class="by" target="_blank" rel="noopener" href="'+esc(socHref)+'">'+(w.avatar?esc(w.avatar)+' ':'')+by+'</a>'
                  :'<span class="by">'+(w.avatar?esc(w.avatar)+' ':'')+by+'</span>')+
          '<button class="likeBtn'+(w.liked?' on':'')+'" data-slug="'+esc(w.slug)+'">♥ '+Number(w.likes||0)+'</button>'+
          '<a class="btn sm ghost" href="'+url+'" target="_blank" rel="noopener">Walk</a>'+
        '</div>';
      grid.appendChild(d);
    });
    grid.querySelectorAll('.likeBtn').forEach(b=>b.onclick=()=>toggleLike(b));
  }catch(e){ /* leave whatever the plain listing rendered */ }
}
window.__renderLibrary=renderLibrary;

async function toggleLike(btn){
  const{data:{session}}=await sb.auth.getSession();
  if(!session){
    btn.textContent='sign in to like';
    setTimeout(()=>renderLibrary(),1200);
    return;
  }
  const slug=btn.dataset.slug;
  const wasOn=btn.classList.contains('on');
  const n=Number((btn.textContent.match(/\d+/)||[0])[0]);
  btn.classList.toggle('on',!wasOn);
  btn.textContent='♥ '+(wasOn?Math.max(0,n-1):n+1);
  const q=wasOn
    ? sb.from('m3ix_likes').delete().eq('slug',slug).eq('user_id',session.user.id)
    : sb.from('m3ix_likes').insert({slug,user_id:session.user.id});
  const{error}=await q;
  if(error){ btn.classList.toggle('on',wasOn); btn.textContent='♥ '+n; }
}
/* Say so when a sign-in round trip comes back empty, instead of silently
   showing the signed-out page and leaving someone to guess. */
(async function reportFailedReturn(){
  const q=new URLSearchParams(location.search);
  const h=new URLSearchParams(location.hash.replace(/^#/,''));
  const came=q.has('code')||h.has('access_token')||q.has('error')||h.has('error');
  if(!came)return;
  const err=q.get('error_description')||h.get('error_description')||q.get('error')||h.get('error');
  await new Promise(r=>setTimeout(r,900));           // give the exchange a moment
  const{data:{session}}=await sb.auth.getSession();
  if(session)return;
  say('#acctMsg', err
    ? ('Sign-in was refused: '+err)
    : 'Signed in with Google, but the session did not come back. This is almost always the Supabase redirect settings — Site URL must be https://www.m3xi.com with https://www.m3xi.com/** allowed.',
    true);
})();
/* ---------- affiliate ---------------------------------------------------------
   The code arrives in the link, but the person is usually not signed in yet when
   they click it — so hold it and claim it the moment an account exists. */
const REF_KEY='m3xi.ref';
(function captureRef(){
  const r=new URLSearchParams(location.search).get('ref');
  if(r&&/^[A-Z0-9]{4,10}$/i.test(r)){try{localStorage.setItem(REF_KEY,r.toUpperCase());}catch(e){}}
})();
async function claimRefIfAny(){
  let r=null;try{r=localStorage.getItem(REF_KEY);}catch(e){}
  if(!r)return;
  try{
    const{data}=await sb.rpc('m3ix_claim_referral',{p_code:r});
    // Clear on any settled outcome — retrying a rejected code forever is noise.
    if(data&&(data.ok||['already_referred','self_referral','unknown_code'].includes(data.code))){
      try{localStorage.removeItem(REF_KEY);}catch(e){}
    }
  }catch(e){}
}
async function paintReferral(){
  const link=$('#refLink'),stat=$('#refStat');
  if(!link)return;
  try{
    const{data,error}=await sb.rpc('m3ix_my_referral');
    if(error||!data||data.error)return;
    link.value=canonicalOrigin()+'/studio/?ref='+data.code;
    const d=Number(data.discount_pct||0);
    stat.textContent=(data.signed_up||0)+' signed up · '+(data.rewarded||0)+' have paid'+
      (d>0?(' · '+d+'% waiting on your next purchase'):' · no discount yet');
  }catch(e){}
}
$('#btnCopyRef')&&($('#btnCopyRef').onclick=()=>{
  const el=$('#refLink');if(!el||!el.value)return;
  el.select();
  try{navigator.clipboard.writeText(el.value);}catch(e){document.execCommand('copy');}
  say('#refStat','Link copied.');setTimeout(paintReferral,1400);
});

/* ---------- posting settings --------------------------------------------------
   Saved even while nothing is connected, because the schedule is the part people
   want to decide up front. Posting itself stays inert until a platform app
   exists — see the note this paints under the form. */
/* A schedule you cannot see is indistinguishable from one that is not running.
   This is the proof that a clip went somewhere and when it goes out. */
async function paintQueue(){
  const box=$('#queueBox');if(!box)return;
  try{
    const{data,error}=await sb.rpc('m3ix_my_queue',{p_limit:12});
    if(error)return;
    if(!data||!data.length){box.innerHTML='<p class="small" style="opacity:.7">Nothing queued yet. Clips you make in UGC land here on your schedule.</p>';return;}
    const esc=t=>String(t==null?'':t).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    box.innerHTML='<div class="small" style="opacity:.75;margin-bottom:6px">Coming up</div>'+
      data.map(q=>{
        const when=new Date(q.scheduled_for);
        const due=when<=new Date();
        return '<div class="srow" style="justify-content:space-between;margin-top:4px;border-bottom:1px dashed rgba(22,21,18,.2);padding-bottom:4px">'+
          '<span class="small"><b>'+esc(q.platform)+'</b> · '+esc(q.caption||'clip')+'</span>'+
          '<span class="small" style="opacity:.75">'+when.toLocaleString()+(due?' · due':'')+
          (q.last_error?' · <span style="color:var(--red)">held</span>':'')+'</span></div>';
      }).join('');
  }catch(e){}
}
async function paintSocial(){
  const box=$('#setAutoPost');if(!box)return;
  try{
    const{data}=await sb.from('m3ix_post_settings').select('*').maybeSingle();
    if(data){
      box.checked=!!data.auto_post;
      $('#setBatch').value=data.batch_size||1;
      $('#setSpacing').value=((data.spacing_minutes||180)/60).toFixed(2).replace(/\.?0+$/,'');
      $('#setStart').value=data.daily_start_hour||9;
      $('#setAutoGen').checked=!!data.auto_generate;
      $('#setAutoGenN').value=data.auto_generate_n||0;
      document.querySelectorAll('.plat').forEach(c=>{c.checked=(data.platforms||[]).includes(c.value);});
    }
    const{data:conns}=await sb.from('m3ix_social_accounts').select('platform,status');
    const live=(conns||[]).filter(c=>c.status==='connected').map(c=>c.platform);
    const note=$('#socialNote');
    if(note)note.innerHTML=live.length
      ? ('Connected: <b>'+live.join(', ')+'</b>. Clips will be released on the schedule above.')
      : 'No account is connected yet, so nothing will actually be posted — the schedule is saved and clips queue up ready. Connecting TikTok, Instagram or YouTube needs a developer app registered under your own business account; tell M3XI and we will wire it to your settings.';
  }catch(e){}
}
$('#btnSaveSocial')&&($('#btnSaveSocial').onclick=async()=>{
  const{data:{session}}=await sb.auth.getSession();
  if(!session)return say('#socialMsg','Sign in first.',true);
  const platforms=[...document.querySelectorAll('.plat')].filter(c=>c.checked).map(c=>c.value);
  const hours=Math.max(0.25,Math.min(24,Number($('#setSpacing').value)||3));
  const row={
    user_id:session.user.id,
    auto_post:$('#setAutoPost').checked,
    platforms,
    batch_size:Math.max(1,Math.min(10,Number($('#setBatch').value)||1)),
    spacing_minutes:Math.round(hours*60),
    daily_start_hour:Math.max(0,Math.min(23,Number($('#setStart').value)||9)),
    auto_generate:$('#setAutoGen').checked,
    auto_generate_n:Math.max(0,Math.min(20,Number($('#setAutoGenN').value)||0)),
    updated_at:new Date().toISOString()
  };
  say('#socialMsg','Saving…');
  const{error}=await sb.from('m3ix_post_settings').upsert(row,{onConflict:'user_id'});
  say('#socialMsg',error?('Could not save: '+error.message):'Saved.',!!error);
  paintSocial();paintQueue();
});
/* DEFERRED, never direct: the auth client AWAITS these callbacks while it
   initialises, and refreshAccount's first act is getSession(), which waits for
   initialisation — a perfect deadlock. It hid for weeks because nobody ever
   HAD a stored session (the fragment bug), and a hung refreshAccount paints
   nothing, which looks exactly like being signed out. */
sbReady.then(()=>{
  sb.auth.onAuthStateChange(()=>{setTimeout(refreshAccount,0);});
  refreshAccount();
});
/* The sign-in round trip lands with ?panel=account (never a fragment — see
   returnUrl). Take the visitor to their panel, then clean the address bar so
   a reload or share does not repeat the scroll. */
(function landOnPanel(){
  const q=new URLSearchParams(location.search);
  if(q.get('panel')!=='account')return;
  q.delete('panel');
  const rest=q.toString();
  history.replaceState(null,'',location.pathname+(rest?'?'+rest:'')+location.hash);
  const el=document.getElementById('account');
  if(el)setTimeout(()=>el.scrollIntoView({behavior:'smooth',block:'start'}),350);
})();
window.__sb=sb;   // replaced with the real client by sbReady
