/* Fast bidirectional matching. Optimistic UI + durable, serial, idempotent saves. */
let vocabState=null,vocabBound=false,vocabPaused=false,selected=null,loadingNext=false;
let pending=[],pendingBatchId=null,saving=false,saveError='',storageError='',mountedSession=null;
let pumpPromise=null,flashSerial=0,audioToken=0,playing=null,localPageTimer=null;
let recordTimer=null;
let historyData=null,historyMonth=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}).slice(0,7),historyLoading=false;
const flashes=new Map(),audioPool=new Map(),OUTBOX='jlpt-matching-outbox-v2';
const ve=id=>document.getElementById(id);
const vesc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function vocabRequest(path,body){
  const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'本地保存失败，请重试');
  return data;
}
function writeOutbox(){
  try{localStorage.setItem(OUTBOX,JSON.stringify({version:1,actions:pending,batchId:pendingBatchId}));storageError=''}
  catch{storageError='浏览器未能暂存本组答案，关闭前请等待本组保存完成。'}
}
function restoreOutbox(){
  try{
    const raw=JSON.parse(localStorage.getItem(OUTBOX)||'[]');
    const data=Array.isArray(raw)?raw:raw?.actions;
    if(!Array.isArray(data)||data.some(a=>!a||!['sessionId','wordId','targetId'].every(k=>typeof a[k]==='string')))throw Error();
    pending=data;pendingBatchId=Array.isArray(raw)?null:(typeof raw.batchId==='string'?raw.batchId:null);
  }catch{saveError='暂存答案无法读取，请保留当前页面并联系我检查。'}
}
function questions(){return vocabState?.session?.questions||[]}
function allQuestions(){return vocabState?.session?.allQuestions||questions()}
function displayQuestions(){
  const list=questions().map(q=>({...q}));
  for(const action of pending){
    if(action.sessionId!==vocabState.session.id)continue;
    const q=list.find(w=>w.id===action.wordId),target=list.find(w=>w.id===action.targetId);
    if(q&&target&&!q.matched){
      if(q.meaning===target.meaning){q.matched=true;q.matchedTargetId=target.id}
      else if(q.selected===undefined)q.selected=-1;
    }
  }
  return list;
}
function allMatched(){
  const matched=new Set(allQuestions().filter(q=>q.matched).map(q=>q.id));
  const map=new Map(allQuestions().map(q=>[q.id,q]));
  for(const a of pending){
    if(a.sessionId!==vocabState?.session?.id)continue;
    if(map.has(a.wordId)&&map.has(a.targetId)&&map.get(a.wordId).meaning===map.get(a.targetId).meaning)matched.add(a.wordId);
  }
  return allQuestions().length>0&&allQuestions().every(q=>matched.has(q.id));
}
function resumeLocalPage(){
  const group=vocabState?.session;if(!group)return;
  const all=allQuestions();
  const matched=new Set(all.filter(q=>q.matched).map(q=>q.id)),map=new Map(all.map(q=>[q.id,q]));
  for(const a of pending){
    if(a.sessionId===group.id&&map.get(a.wordId)?.meaning===map.get(a.targetId)?.meaning)matched.add(a.wordId);
  }
  const index=all.findIndex(q=>!matched.has(q.id));
  group.pageNo=index<0?group.pageCount:Math.floor(index/5)+1;
  group.questions=all.slice((group.pageNo-1)*5,group.pageNo*5);
  group.pageTotal=group.questions.length;
}
function displayRewards(){
  const g=vocabState.game,preview={combo:g.combo||0,xp:g.xp,gems:g.gems||0};
  const qs=new Map(allQuestions().map(q=>[q.id,{...q}]));
  for(const action of pending){
    if(action.sessionId!==vocabState.session?.id)continue;
    const q=qs.get(action.wordId),t=qs.get(action.targetId);
    if(!q||!t||q.matched)continue;
    if(q.meaning===t.meaning){q.matched=true;preview.combo++;preview.xp+=10;if(preview.combo%10===0)preview.xp+=30;if(preview.combo%100===0)preview.gems++}
    else if(q.selected===undefined){preview.combo=0;q.selected=-1}
  }
  return preview;
}
// 连对奖励（+30 XP / +1 宝石）照常计算，但不再弹提示——弹一次灭一次会把整块
// 板子往上顶再落回来。现在只有"破纪录"这一种情况会给反馈，且写在固定的
// #comboGap 上就地改文字，不新增节点，行高不变，页面不会跳。
function showRecord(combo){
  const el=ve('comboGap');
  if(!el)return;
  el.textContent='⚡ 新纪录 连击 '+combo;
  el.classList.add('combo-record');
  clearTimeout(recordTimer);
  recordTimer=setTimeout(()=>{
    const node=ve('comboGap');
    if(node){node.classList.remove('combo-record');renderQuiz()}
  },1800);
}
function shuffled(group){
  const ids=group.questions.map(q=>q.id);let seed=2166136261;
  for(const char of group.id)seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
  for(let i=ids.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[ids[i],ids[j]]=[ids[j],ids[i]]}
  if(ids.every((id,i)=>id===group.questions[i].id))ids.push(ids.shift());
  return ids;
}
function audioNotice(message){ve('quizNotice').textContent=message;ve('quizNotice').className='error'}
function localAudio(src){
  if(!src)return null;
  const url=new URL(src,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith('/resources/'))return null;
  if(!audioPool.has(url.href)){const audio=new Audio(url.href);audio.preload='auto';audioPool.set(url.href,audio)}
  return audioPool.get(url.href);
}
function stopAudio(){
  ++audioToken;
  if(playing){playing.onended=null;playing.onerror=null;playing.pause();playing.currentTime=0;playing=null}
}
function playSequence(sources){
  stopAudio();const token=audioToken;
  function playAt(index){
    if(token!==audioToken||index>=sources.length)return;
    const {src,label}=sources[index],audio=localAudio(src);
    if(!audio){audioNotice(label+'本地音频缺失，不使用合成语音替代。');return}
    playing=audio;audio.currentTime=0;
    audio.onended=()=>{if(token===audioToken){playing=null;playAt(index+1)}};
    audio.onerror=()=>{if(token===audioToken)audioNotice(label+'本地音频无法播放，请检查资源文件。')};
    audio.play().catch(err=>{if(token===audioToken&&err.name!=='AbortError')audioNotice(label+'音频播放失败：'+err.message)});
  }
  playAt(0);
}
function wordSound(q){return {src:q.wordAudio||q.audio,label:'单词'}}
function exampleSound(q){return {src:q.exampleAudio,label:'例句'}}
function warmAudio(group){
  audioPool.forEach(audio=>{if(audio!==playing){audio.pause();audio.removeAttribute('src');audio.load()}});
  audioPool.clear();
  group.questions.forEach(q=>{localAudio(q.wordAudio||q.audio);localAudio(q.exampleAudio)});
}
function mountBoard(group){
  const pageKey=group.id+':'+(group.pageNo||1);
  if(mountedSession===pageKey)return;
  mountedSession=pageKey;selected=null;flashes.clear();warmAudio(group);
  const left=group.questions.map((q,i)=>'<button type="button" class="match-tile jp" data-jp="'+vesc(q.id)+'"><span class="word-number">'+(i+1)+'</span><strong lang="ja">'+vesc(q.word)+'</strong><em lang="ja">[例] '+(q.exampleRuby||vesc(q.example||''))+'</em></button>').join('');
  const byId=Object.fromEntries(group.questions.map(q=>[q.id,q]));
  const right=shuffled(group).map(id=>'<button type="button" class="match-tile zh" data-meaning="'+vesc(id)+'"><strong>'+vesc(byId[id].meaning)+'</strong><small class="reading" lang="ja" hidden></small><span class="zh-meta"><em class="translation"></em></span></button>').join('');
  ve('quizBody').innerHTML='<div class="match-toolbar"><div class="combo-area"><strong id="comboValue">Combo × 0</strong><small id="comboGap" aria-live="polite"></small><small id="matchStatus" role="status"></small></div><button class="secondary" data-pause>暂停连刷</button></div><div class="match-board"><div class="match-column"><h3>日语</h3>'+left+'</div><div class="match-column"><h3>中文</h3>'+right+'</div></div><div id="matchSummary" role="status"></div><button class="secondary" id="retrySave" data-retry hidden>重试保存</button>';
}
function renderQuiz(){
  if(!vocabState)return;
  const s=vocabState,g=s.game,group=s.session,asset=displayRewards();
  ve('coverageStat').textContent=(s.coveragePct==null?'—':s.coveragePct+'%（'+(s.newSeen??s.seen)+'/'+(s.newTotal??s.wordCount)+'）');
  ve('errorStat').textContent=String(s.errorWords??s.errors??0);
  ve('remainingStat').textContent=String(s.remainingGroups??0)+' 组';
  ve('coverageStage').textContent=s.stage+' ';
  ve('remainingStage').textContent=s.stage+' ';
  const cumulative=s.cumulativeStats;
  const statsLine=ve('lastResult');
  statsLine.textContent=cumulative?'累计记过 '+cumulative.seen+'/'+cumulative.total+' 词 · 全词库剩余 '+cumulative.remaining+' 词 · 累计错词 '+cumulative.errorWords+' 个 · 错词率 '+cumulative.errorRate.toFixed(1)+'%':'正在读取全词库统计…';
  statsLine.hidden=false;
  statsLine.title='记过按已作答词去重统计；累计错词率 = 曾答错的去重词数 ÷ 已作答的去重词数。复习不重复计数，尚未作答的新词不计入。';
  if(!ve('streakToggle'))ve('gameStats').innerHTML='<button type="button" id="streakToggle" class="streak-line" aria-expanded="false" aria-controls="streakHistory" aria-label="展开或收起词汇学习历史"><span id="streakFlame" class="streak-flame">🔥</span><strong id="streakText"></strong><small>▾</small></button><div class="xp-line">经验 <span id="xpValue"></span> XP · 💎 宝石 <span id="gemValue"></span> · ⚡ 最高连击 <span id="bestComboValue"></span></div>';
  ve('streakFlame').className='streak-flame '+(s.todayCompleted?'full':'empty');
  ve('streakFlame').setAttribute('aria-label',s.todayCompleted?'今日已完成':'今日无完成组记录');
  ve('streakText').textContent='连胜 '+g.streak+' 天 · 最长 '+g.bestStreak+' 天';
  ve('xpValue').textContent=asset.xp;ve('gemValue').textContent=asset.gems;
  // 最高连击：取服务端历史最大与本次实时连击的较大者，免得要等保存回来才更新
  ve('bestComboValue').textContent=Math.max(g.bestCombo||0,asset.combo||0);
  ve('quizSource').textContent=s.source.title+'。'+s.source.note;
  if(!group){ve('quizBody').innerHTML='<button data-resume>打开一组5词</button>';return}
  mountBoard(group);
  ve('quizKind').textContent=group.mode==='review'?'复习组':'新词组';
  ve('quizKind').className=group.mode==='review'?'eyebrow review':'eyebrow';
  ve('quizHeading').textContent='第 '+group.number+' 组 · '+group.stage+' 词汇'+(group.mode==='review'?' · 第 '+group.pageNo+'/'+group.pageCount+' 页':'');
  const version=document.createElement('span');version.className='version-label';version.textContent='v'+(s.appVersion||'—');ve('quizHeading').appendChild(version);
  const qs=displayQuestions(),matchedCount=qs.filter(q=>q.matched).length;
  const pageTotal=group.pageTotal??5,total=group.total??5,groupCount=(group.answered||0)-(group.pageAnswered??group.answered??0)+matchedCount;
  ve('quizInfo').textContent='';
  const owners=new Map(qs.filter(q=>q.matched).map(q=>[q.matchedTargetId||q.id,q]));
  function update(button,q,side){
    const id=q.id,owner=side==='jp'?(q.matched?q:null):owners.get(id),done=Boolean(owner);
    const flash=flashes.get(side+':'+id),chosen=selected?.side===side&&selected.id===id;
    button.classList.toggle('selected',chosen);
    button.classList.toggle('green',flash==='green');
    button.classList.toggle('wrong',flash==='wrong');
    button.classList.toggle('matched',done&&flash!=='green');
    button.disabled=done||vocabPaused;
    button.setAttribute('aria-pressed',String(chosen));
    if(side==='zh'){
      const el=button.querySelector('.translation');el.textContent=done?'[译] '+(owner.exampleTranslation||'译文缺失'):'';el.classList.toggle('revealed',done);
      const rd=button.querySelector('.reading');if(rd){rd.textContent=done?(owner.reading||''):'';rd.classList.toggle('revealed',done);rd.hidden=!done}
    }
  }
  const byId=Object.fromEntries(qs.map(q=>[q.id,q]));
  ve('quizBody').querySelectorAll('[data-jp]').forEach(b=>update(b,byId[b.dataset.jp],'jp'));
  ve('quizBody').querySelectorAll('[data-meaning]').forEach(b=>update(b,byId[b.dataset.meaning],'zh'));
  const pause=ve('quizBody').querySelector('[data-pause],[data-resume]');
  if(pause){pause.textContent=vocabPaused?'继续连刷':'暂停连刷';pause.removeAttribute(vocabPaused?'data-pause':'data-resume');pause.setAttribute(vocabPaused?'data-resume':'data-pause','')}
  const value=ve('comboValue'),next='Combo × '+asset.combo;
  if(value.textContent!==next){value.textContent=next;value.classList.remove('combo-pop');void value.offsetWidth;value.classList.add('combo-pop')}
  // 距历史最高连击还差多少（历史值来自服务端事件流，含本次实时连击）
  const bestNow=Math.max(g.bestCombo||0,asset.combo||0),gap=bestNow-asset.combo;
  const gapEl=ve('comboGap');
  if(gapEl){gapEl.textContent=!bestNow?'':gap>0?'距纪录还差 '+gap+' 次':'已到纪录线'}
  ve('matchStatus').textContent=vocabPaused?'已暂停':saveError?'本组保存失败，点击重试':'';
  ve('matchSummary').textContent='';
  ve('retrySave').hidden=!saveError;
  if(saveError||storageError){ve('quizNotice').textContent=saveError||storageError;ve('quizNotice').className='error'}
}
function flash(wordId,targetId,hit){
  const token=++flashSerial,sid=vocabState.session.id,color=hit?'green':'wrong';
  const keys=['jp:'+wordId,'zh:'+targetId];
  keys.forEach(key=>{flashes.set(key,color);flashes.set(key+':token',token)});
  setTimeout(()=>{
    if(vocabState?.session?.id!==sid)return;
    keys.forEach(key=>{if(flashes.get(key+':token')===token){flashes.delete(key);flashes.delete(key+':token')}});
    renderQuiz();
  },180);
}
function recordPair(q,target,reverse){
  const hit=q.meaning===target.meaning;
  const previous=displayRewards();
  // Repeated wrong guesses in the same word neither reset combo again nor add
  // memory errors. Keep just the first error, with every successful match.
  if(hit||q.selected===undefined)pending.push({sessionId:vocabState.session.id,wordId:q.id,targetId:target.id});
  writeOutbox();
  if(hit)selected=null; // On error retain whichever side was selected first.
  flash(q.id,target.id,hit);
  if(reverse)playSequence(hit?[wordSound(q),exampleSound(q)]:[wordSound(q)]);
  else if(hit)playSequence([exampleSound(q)]);
  renderQuiz();
  const current=displayRewards();
  if(hit&&current.combo>previous.combo){
    // 先跟服务端已知的最大值比，再本地抬上去，避免同一串里反复弹"新纪录"
    const knownBest=vocabState.game.bestCombo||0;
    const isRecord=current.combo>knownBest;
    if(isRecord)vocabState.game.bestCombo=current.combo;
    if(isRecord&&current.combo>=5)showRecord(current.combo);
  }
  if(displayQuestions().every(item=>item.matched)){
    if(vocabState.session.pageNo < vocabState.session.pageCount){
      clearTimeout(localPageTimer);localPageTimer=setTimeout(advanceLocalPage,180);
    }
    else pumpSaves();
  }
}
function advanceLocalPage(){
  const session=vocabState.session,all=session.allQuestions||[];
  if(vocabPaused||session.pageNo>=session.pageCount||!all.length)return;
  session.pageNo+=1;session.questions=all.slice((session.pageNo-1)*5,session.pageNo*5);
  session.pageTotal=session.questions.length;mountedSession=null;selected=null;renderQuiz();
}
function handlePairClick(event){
  if(vocabPaused||saving||pendingBatchId)return;
  const b=event.target.closest('[data-jp],[data-meaning]');if(!b||b.disabled)return;
  const side=b.hasAttribute('data-jp')?'jp':'zh',id=side==='jp'?b.dataset.jp:b.dataset.meaning;
  const qs=displayQuestions(),q=qs.find(w=>w.id===id);
  if(!q)return;
  if(!selected||selected.side===side){
    selected={side,id};flashes.delete(side+':'+id);
    if(side==='jp')playSequence([wordSound(q)]);
    renderQuiz();return;
  }
  const first=qs.find(w=>w.id===selected.id);if(!first){selected=null;return}
  recordPair(side==='jp'?q:first,side==='zh'?q:first,side==='jp');
}
function pumpSaves(){
  if(saving||saveError||!pending.length||!allMatched())return pumpPromise;
  saving=true;
  pumpPromise=(async()=>{
    try{
      const batchId=pendingBatchId||crypto.randomUUID();pendingBatchId=batchId;writeOutbox();
      const data=await vocabRequest('/api/vocab/match-batch',{sessionId:pending[0].sessionId,batchId,actions:pending});
      vocabState=data;pending=[];pendingBatchId=null;writeOutbox();
      if(data.session?.done&&!ve('streakHistory').hidden)loadHistory();
      ve('quizNotice').textContent='';ve('quizNotice').className='';renderQuiz();
    }catch(error){saveError=error.message+'；本组答案已保留，请重试。'}
    finally{saving=false;renderQuiz();maybeAdvance()}
  })();
  return pumpPromise;
}
async function maybeAdvance(){
  if(!vocabState?.session?.done||pending.length||saving||saveError||vocabPaused||loadingNext)return;
  await nextGroup();
}
async function nextGroup(){
  if(loadingNext||pending.length||saving||saveError||vocabPaused)return;
  loadingNext=true;renderQuiz();
  try{
    vocabState=await vocabRequest('/api/vocab/next',{});
    if(vocabState.blockedReason){vocabPaused=true;ve('quizNotice').textContent=vocabState.blockedReason}
    selected=null;renderQuiz();
  }catch(error){saveError=error.message+'；点击重试继续，不会跳过当前进度。';renderQuiz()}
  finally{loadingNext=false;renderQuiz();if(vocabState?.session?.result?.skipped&&!vocabPaused&&!saveError)setTimeout(maybeAdvance,0)}
}
async function setupQuiz(){
  if(!vocabBound){
    const guideToggle=ve('guideToggle'),guide=ve('usageGuide');
    const setGuide=open=>{guide.hidden=!open;guideToggle.setAttribute('aria-expanded',String(open));if(!open)guideToggle.focus()};
    guideToggle.addEventListener('click',()=>setGuide(guide.hidden));
    ve('guideClose').addEventListener('click',()=>setGuide(false));
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!guide.hidden)setGuide(false)});
    ve('gameStats').addEventListener('click',e=>{if(e.target.closest('#streakToggle')){
      const panel=ve('streakHistory');panel.hidden=!panel.hidden;
      ve('streakToggle').setAttribute('aria-expanded',String(!panel.hidden));
      if(!panel.hidden)loadHistory();
    }});
    ve('historyPrev').addEventListener('click',()=>changeHistoryMonth(-1));
    ve('historyNext').addEventListener('click',()=>changeHistoryMonth(1));
    ve('quizBody').addEventListener('click',e=>{
      const b=e.target.closest('button');if(!b||b.disabled)return;
      if(b.hasAttribute('data-jp')||b.hasAttribute('data-meaning')){handlePairClick(e);return}
      if(b.hasAttribute('data-pause')){vocabPaused=true;selected=null;stopAudio();renderQuiz();return}
      if(b.hasAttribute('data-resume')){vocabPaused=false;resumeLocalPage();renderQuiz();if(allMatched()&&pending.length)pumpSaves();else if(vocabState?.session)maybeAdvance();else nextGroup();return}
      if(b.hasAttribute('data-retry')){saveError='';if(pending.length)pumpSaves();else if(vocabState?.session?.done)maybeAdvance();else setupQuiz()}
    });
    ve('exportVocab').addEventListener('click',async()=>{
      try{const d=await vocabRequest('/api/vocab/export'),u=URL.createObjectURL(new Blob([JSON.stringify(d,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='词汇记忆记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
      catch(error){audioNotice(error.message)}
    });
    window.addEventListener('beforeunload',event=>{if(storageError&&pending.length){event.preventDefault();event.returnValue=''}});
    vocabBound=true;restoreOutbox();
  }
  try{
    const sid=pending[0]?.sessionId;
    if(pending.some(a=>a.sessionId!==sid))throw Error('存在不同组的本地答案，请保留页面并联系我核对。');
    vocabState=await vocabRequest('/api/vocab/state'+(sid?'?sessionId='+encodeURIComponent(sid):''));
    if(!vocabState.session&&!pending.length)vocabState=await vocabRequest('/api/vocab/next',{});
    resumeLocalPage();renderQuiz();
    if(pending.length){if(allMatched())pumpSaves()}
    else maybeAdvance();
  }catch(error){audioNotice(error.message);ve('quizBody').innerHTML='<button data-retry>重新连接并读取进度</button>'}
}

async function loadHistory(){
  if(historyLoading)return;
  historyLoading=true;ve('historyNotice').textContent='读取历史…';
  try{historyData=await vocabRequest('/api/vocab/history');renderHistory();ve('historyNotice').textContent='已保存的完整组（北京时间）'}
  catch(error){ve('historyNotice').textContent='历史读取失败；收起后再展开可重试。'+error.message}
  finally{historyLoading=false}
}
function changeHistoryMonth(delta){
  const [y,m]=historyMonth.split('-').map(Number),d=new Date(Date.UTC(y,m-1+delta,1));
  historyMonth=d.toISOString().slice(0,7);renderHistory();
}
function renderHistory(){
  ve('historyMonth').textContent=historyMonth;
  const [year,month]=historyMonth.split('-').map(Number);
  const offset=(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7;
  const count=new Date(Date.UTC(year,month,0)).getUTCDate();
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  let html=['一','二','三','四','五','六','日'].map(s=>'<div class="history-weekday">'+s+'</div>').join('');
  html+='<div aria-hidden="true"></div>'.repeat(offset);
  for(let d=1;d<=count;d++){
    const date=historyMonth+'-'+String(d).padStart(2,'0'),entry=historyData?.days?.[date],groups=entry?.groups||[];
    const groupsTotal=groups.length,legacy=entry?.legacyUnits||0;
    const display=groupsTotal?groupsTotal+' 组'+(legacy?' · 旧记录':''):legacy?'旧记录':date>today?'未到':'无记录';
    html+='<div class="history-day '+(groupsTotal||legacy?'recorded':'')+'" data-date="'+date+'"'+(date===today?' aria-current="date"':'')+'><strong>'+d+'</strong><span>'+display+'</span></div>';
  }
  ve('historyCalendar').innerHTML=html;
}
