const SLOT_COUNT = 36;
const DB_NAME = "pon-se-board-db";
const DB_VERSION = 1;
const STORE_NAME = "audioFiles";
const STORAGE_KEY = "pon-se-board-settings-v1"; // v1の登録内容をそのまま引き継ぐ

const palette = [
  "#ffd1e3", "#ffc9d2", "#ffe2b7", "#fff1a9",
  "#dff5b5", "#c9f2df", "#c8edff", "#d9ddff",
  "#e5d3ff", "#f1d5ff", "#f5d6e7", "#e7e4f5"
];
const defaultEmojis = ["🐾","😂","😱","🎉","💥","✨","🥁","🔔","💡","🎺","🎮","💖"];
const shapes = [
  { id: "squircle", label: "ぷに四角", icon: "🍮" },
  { id: "circle", label: "まんまる", icon: "🫧" },
  { id: "paw", label: "肉球", icon: "🐾" }
];
const shapePattern = ["paw","circle","squircle","circle","paw","squircle","circle","paw","squircle","circle","paw","squircle"];

let slots = [];
let editMode = false;
let editingIndex = null;
let selectedColor = palette[0];
let selectedShape = "squircle";
let pendingFile = null;
let activeAudios = new Set();
let db = null;
let draggedIndex = null;

const $ = id => document.getElementById(id);
const board = $("board");
const dialog = $("editorDialog");

function newId(i=0) {
  return crypto.randomUUID ? crypto.randomUUID() : `slot-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`;
}
function freshSlot(i) {
  return {
    id: newId(i), name: "", emoji: defaultEmojis[i % defaultEmojis.length],
    color: palette[i % palette.length], volume: 1, fileName: "",
    shape: shapePattern[i % shapePattern.length]
  };
}
function freshSlots() { return Array.from({length:SLOT_COUNT},(_,i)=>freshSlot(i)); }

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.slots?.length === SLOT_COUNT) {
      slots = saved.slots.map((slot,i)=>({ ...freshSlot(i), ...slot, shape: slot.shape || shapePattern[i % shapePattern.length] }));
      $("masterVolume").value = saved.masterVolume ?? 1;
    } else slots = freshSlots();
  } catch { slots = freshSlots(); }
  updateMasterLabel();
}
function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ slots, masterVolume:Number($("masterVolume").value) }));
}

function openDB() {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{ const d=req.result; if(!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME); };
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
function putAudio(id,file){ return new Promise((resolve,reject)=>{ const tx=db.transaction(STORE_NAME,"readwrite"); tx.objectStore(STORE_NAME).put(file,id); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }
function getAudio(id){ return new Promise((resolve,reject)=>{ const tx=db.transaction(STORE_NAME,"readonly"); const req=tx.objectStore(STORE_NAME).get(id); req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error); }); }
function deleteAudio(id){ return new Promise((resolve,reject)=>{ const tx=db.transaction(STORE_NAME,"readwrite"); tx.objectStore(STORE_NAME).delete(id); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }

function pawDecor(shape){
  if(shape!=="paw") return "";
  return `<span class="paw-body"></span><span class="paw-toe t1"></span><span class="paw-toe t2"></span><span class="paw-toe t3"></span><span class="paw-toe t4"></span>`;
}
function render() {
  board.innerHTML="";
  slots.forEach((slot,index)=>{
    const btn=document.createElement("button");
    btn.type="button";
    const shape = slot.shape || shapePattern[index % shapePattern.length];
    btn.className=`pad shape-${shape} ${slot.fileName?"":"empty"}`;
    btn.style.setProperty("--pad-color", slot.color);
    btn.draggable=editMode;
    btn.dataset.index=index;
    btn.innerHTML=`${pawDecor(shape)}
      <span class="pad-number">${String(index+1).padStart(2,"0")}</span>
      <span class="pad-content">
        <span class="pad-emoji">${escapeHtml(slot.emoji||"🎵")}</span>
        <span class="pad-name">${escapeHtml(slot.name||"SEを登録")}</span>
        <span class="pad-sub">${slot.fileName?"TAP TO PLAY":"EMPTY"}</span>
      </span>`;

    let pressTimer=null, longPressed=false;
    btn.addEventListener("pointerdown",()=>{ longPressed=false; pressTimer=setTimeout(()=>{ longPressed=true; openEditor(index); },650); });
    ["pointerup","pointercancel","pointerleave"].forEach(ev=>btn.addEventListener(ev,()=>clearTimeout(pressTimer)));
    btn.addEventListener("click",async()=>{
      if(longPressed) return;
      btn.classList.remove("just-hit"); void btn.offsetWidth; btn.classList.add("just-hit");
      setTimeout(()=>btn.classList.remove("just-hit"),380);
      if(editMode) openEditor(index); else await playSlot(index,btn);
    });
    btn.addEventListener("dragstart",e=>{ draggedIndex=index; btn.classList.add("dragging"); e.dataTransfer.effectAllowed="move"; });
    btn.addEventListener("dragend",()=>{ draggedIndex=null; document.querySelectorAll(".pad").forEach(p=>p.classList.remove("dragging","drag-over")); });
    btn.addEventListener("dragover",e=>{ if(!editMode)return; e.preventDefault(); btn.classList.add("drag-over"); });
    btn.addEventListener("dragleave",()=>btn.classList.remove("drag-over"));
    btn.addEventListener("drop",async e=>{ if(!editMode||draggedIndex===null)return; e.preventDefault(); btn.classList.remove("drag-over"); await swapSlots(draggedIndex,index); });
    board.appendChild(btn);
  });
}
async function swapSlots(a,b){ if(a===b)return; [slots[a],slots[b]]=[slots[b],slots[a]]; saveSettings(); render(); showToast("並び替えました"); }

async function playSlot(index,btn){
  const slot=slots[index];
  if(!slot.fileName){ openEditor(index); return; }
  try {
    const file=await getAudio(slot.id);
    if(!file){ showToast("音声データが見つかりません"); return; }
    const url=URL.createObjectURL(file), audio=new Audio(url);
    audio.dataset.slotIndex=String(index);
    audio.volume=Math.min(1,Number(slot.volume)*Number($("masterVolume").value));
    activeAudios.add(audio); btn.classList.add("playing");
    audio.onended=audio.onerror=()=>{ activeAudios.delete(audio); btn.classList.remove("playing"); URL.revokeObjectURL(url); };
    await audio.play();
  } catch(err){ console.error(err); showToast("再生できませんでした"); }
}
function stopAll(){ activeAudios.forEach(a=>{try{a.pause();a.currentTime=0}catch{}}); activeAudios.clear(); document.querySelectorAll(".pad.playing").forEach(p=>p.classList.remove("playing")); showToast("すべて停止しました"); }

function openEditor(index){
  editingIndex=index; pendingFile=null;
  const slot=slots[index];
  $("editorTitle").textContent=`SE ${String(index+1).padStart(2,"0")} を設定`;
  $("slotName").value=slot.name; $("slotEmoji").value=slot.emoji;
  $("slotVolume").value=slot.volume??1; $("slotVolumeLabel").textContent=`${Math.round((slot.volume??1)*100)}%`;
  $("slotFile").value=""; $("currentFileName").textContent=slot.fileName||"未登録";
  selectedColor=slot.color||palette[0]; selectedShape=slot.shape||shapePattern[index%shapePattern.length];
  renderShapeChoices(); renderColorChoices(); dialog.showModal();
}
function renderShapeChoices(){
  const wrap=$("shapeChoices"); wrap.innerHTML="";
  shapes.forEach(shape=>{
    const b=document.createElement("button"); b.type="button";
    b.className=`shape-choice ${shape.id===selectedShape?"selected":""}`;
    b.innerHTML=`<span class="shape-icon">${shape.icon}</span>${shape.label}`;
    b.addEventListener("click",()=>{ selectedShape=shape.id; renderShapeChoices(); });
    wrap.appendChild(b);
  });
}
function renderColorChoices(){
  const wrap=$("colorChoices"); wrap.innerHTML="";
  palette.forEach(color=>{
    const b=document.createElement("button"); b.type="button";
    b.className=`color-choice ${color===selectedColor?"selected":""}`; b.style.background=color; b.setAttribute("aria-label",color);
    b.addEventListener("click",()=>{selectedColor=color; renderColorChoices();}); wrap.appendChild(b);
  });
}
async function saveEditor(){
  if(editingIndex===null)return;
  const slot=slots[editingIndex];
  slot.name=$("slotName").value.trim(); slot.emoji=$("slotEmoji").value.trim()||"🎵";
  slot.color=selectedColor; slot.shape=selectedShape; slot.volume=Number($("slotVolume").value);
  if(pendingFile){ try{ await putAudio(slot.id,pendingFile); slot.fileName=pendingFile.name; }catch(err){console.error(err);showToast("音声の保存に失敗しました");return;} }
  saveSettings(); render(); dialog.close(); showToast("ぷにっと保存しました ♡");
}
async function clearSlot(){
  if(editingIndex===null)return;
  const old=slots[editingIndex]; await deleteAudio(old.id).catch(()=>{}); slots[editingIndex]=freshSlot(editingIndex);
  saveSettings(); render(); dialog.close(); showToast("登録を解除しました");
}
function updateMasterLabel(){ $("masterVolumeLabel").textContent=`${Math.round(Number($("masterVolume").value)*100)}%`; }
function showToast(message){ const t=$("toast"); t.textContent=message; t.classList.add("show"); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>t.classList.remove("show"),1500); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

$("editToggle").addEventListener("click",()=>{ editMode=!editMode; $("editToggle").classList.toggle("active",editMode); $("editToggle").textContent=editMode?"✅ 編集中":"✏️ 編集モード"; render(); });
$("stopAll").addEventListener("click",stopAll);
$("masterVolume").addEventListener("input",()=>{ updateMasterLabel(); activeAudios.forEach(a=>{ const idx=Number(a.dataset?.slotIndex); if(!Number.isNaN(idx)&&slots[idx]) a.volume=Math.min(1,slots[idx].volume*Number($("masterVolume").value)); }); });
$("masterVolume").addEventListener("change",saveSettings);
$("slotVolume").addEventListener("input",()=>{ $("slotVolumeLabel").textContent=`${Math.round(Number($("slotVolume").value)*100)}%`; });
$("slotFile").addEventListener("change",e=>{ pendingFile=e.target.files?.[0]||null; if(pendingFile) $("currentFileName").textContent=pendingFile.name; });
$("saveSlot").addEventListener("click",saveEditor); $("deleteSlot").addEventListener("click",clearSlot);
$("resetAll").addEventListener("click",async()=>{
  if(!confirm("36個すべての設定と音声を削除します。よろしいですか？")) return;
  stopAll(); try{ const tx=db.transaction(STORE_NAME,"readwrite"); tx.objectStore(STORE_NAME).clear(); }catch{}
  localStorage.removeItem(STORAGE_KEY); slots=freshSlots(); $("masterVolume").value=1; updateMasterLabel(); saveSettings(); render(); showToast("初期化しました");
});
window.addEventListener("contextmenu",e=>{ if(e.target.closest(".pad")) e.preventDefault(); });

(async function init(){
  loadSettings();
  try{ db=await openDB(); }catch(err){ console.error(err); alert("端末内ストレージを利用できません。ブラウザのプライベートモード等をご確認ください。"); }
  render();
  if("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(console.warn);
})();
