const SLOT_COUNT = 36;
const DB_NAME = "pon-se-board-db";
const DB_VERSION = 1;
const STORE_NAME = "audioFiles";
const STORAGE_KEY = "pon-se-board-settings-v1";
const VIEWER_VOLUME_KEY = "pon-se-board-viewer-volume-v1";
const OWNER_TOKEN_KEY = "pon-se-board-owner-token-session";

const REPO_OWNER = "papa-blacksmith";
const REPO_NAME = "pon-se-board";
const DATA_BRANCH = "shared-data";
const SHARED_BOARD_PATH = "shared/board.json";
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${DATA_BRANCH}`;

const palette = [
  "#ffd1e3", "#ffc9d2", "#ffe2b7", "#fff1a9",
  "#dff5b5", "#c9f2df", "#c8edff", "#d9ddff",
  "#e5d3ff", "#f1d5ff", "#f5d6e7", "#e7e4f5"
];
const defaultEmojis = ["🐾","😂","😱","🎉","💥","✨","🥁","🔔","💡","🎺","🎮","💖"];
const shapes = [
  { id: "squircle", label: "ぷに四角", icon: "🍮" },
  { id: "circle", label: "まんまる", icon: "🫧" },
  { id: "paw", label: "肉球", icon: "🐾" },
  { id: "heart", label: "ハート", icon: "💗" },
  { id: "flower", label: "お花", icon: "🌸" },
  { id: "star", label: "お星さま", icon: "⭐" }
];
const shapePattern = [
  "paw","circle","heart","flower","star","squircle",
  "circle","paw","flower","heart","squircle","star"
];

let slots = [];
let localDraft = null;
let mode = "viewer";
let editMode = false;
let editingIndex = null;
let selectedColor = palette[0];
let selectedShape = "squircle";
let pendingFile = null;
let activeAudios = new Set();
let db = null;
let draggedIndex = null;
let sharedUpdatedAt = "";
let dirty = false;
let publishing = false;

const $ = id => document.getElementById(id);
const board = $("board");
const dialog = $("editorDialog");
const ownerDialog = $("ownerDialog");

function newId(i=0) {
  return crypto.randomUUID ? crypto.randomUUID() : `slot-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`;
}

function freshSlot(i) {
  return {
    id: `slot-${String(i + 1).padStart(2, "0")}`,
    name: "",
    emoji: defaultEmojis[i % defaultEmojis.length],
    color: palette[i % palette.length],
    volume: 1,
    fileName: "",
    shape: shapePattern[i % shapePattern.length],
    remotePath: ""
  };
}

function freshSlots() {
  return Array.from({length:SLOT_COUNT}, (_,i)=>freshSlot(i));
}

function normalizeSlots(input) {
  return Array.from({length:SLOT_COUNT}, (_,i) => {
    const src = input?.[i] || {};
    return {
      ...freshSlot(i),
      ...src,
      id: src.id || newId(i),
      shape: src.shape || shapePattern[i % shapePattern.length],
      remotePath: src.remotePath || ""
    };
  });
}

function loadLocalDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.slots?.length === SLOT_COUNT) {
      localDraft = {
        slots: normalizeSlots(saved.slots),
        masterVolume: saved.masterVolume ?? 1
      };
      return;
    }
  } catch {}
  localDraft = { slots: freshSlots(), masterVolume: 1 };
}

function saveLocalDraft() {
  if (mode !== "owner") return;
  localDraft = { slots: normalizeSlots(slots), masterVolume:Number($("masterVolume").value) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localDraft));
}

function localDraftHasContent() {
  return !!localDraft?.slots?.some(slot => slot.fileName || slot.name || slot.remotePath);
}

function openDB() {
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putAudio(id,file) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,"readwrite");
    tx.objectStore(STORE_NAME).put(file,id);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
}
function getAudio(id) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,"readonly");
    const req=tx.objectStore(STORE_NAME).get(id);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error);
  });
}
function deleteAudio(id) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,"readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
}

function hasAudio(slot) {
  return !!(slot?.fileName || slot?.remotePath);
}

function encodeRepoPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function remoteAudioUrl(slot) {
  if (!slot.remotePath) return "";
  const rev = encodeURIComponent(sharedUpdatedAt || "latest");
  return `${RAW_BASE}/${encodeRepoPath(slot.remotePath)}?v=${rev}`;
}

async function fetchSharedBoard(showMessage=true) {
  if (showMessage) $("footerStatus").textContent = "☁️ 公開ボードを読み込み中…";
  try {
    const res = await fetch(`${RAW_BASE}/${SHARED_BOARD_PATH}?t=${Date.now()}`, { cache:"no-store" });
    if (!res.ok) throw new Error(`shared board HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.slots)) throw new Error("invalid board data");
    sharedUpdatedAt = data.updatedAt || "";
    if (mode === "viewer") slots = normalizeSlots(data.slots);
    $("footerStatus").textContent = data.updatedAt
      ? `☁️ 公開版：${formatDate(data.updatedAt)}`
      : "☁️ 公開ボードを表示中";
    if (mode === "viewer") render();
    return data;
  } catch (err) {
    console.warn(err);
    if (mode === "viewer") {
      slots = freshSlots();
      render();
    }
    $("footerStatus").textContent = "☁️ 公開データはまだありません";
    return null;
  }
}

function pawDecor(shape) {
  if (shape !== "paw") return "";
  return `<span class="paw-body"></span><span class="paw-toe t1"></span><span class="paw-toe t2"></span><span class="paw-toe t3"></span><span class="paw-toe t4"></span>`;
}

function render() {
  board.innerHTML = "";
  slots.forEach((slot,index)=>{
    const btn=document.createElement("button");
    btn.type="button";
    const shape=slot.shape || shapePattern[index % shapePattern.length];
    const audioReady=hasAudio(slot);
    btn.className=`pad shape-${shape} ${audioReady?"":"empty"}`;
    btn.style.setProperty("--pad-color",slot.color);
    btn.draggable=mode === "owner" && editMode;
    btn.dataset.index=index;
    const cloud = slot.remotePath ? `<span class="cloud-mark" title="公開済み">☁️</span>` : "";
    btn.innerHTML=`${pawDecor(shape)}${cloud}
      <span class="pad-number">${String(index+1).padStart(2,"0")}</span>
      <span class="pad-content">
        <span class="pad-emoji">${escapeHtml(slot.emoji||"🎵")}</span>
        <span class="pad-name">${escapeHtml(slot.name||"SEを登録")}</span>
        <span class="pad-sub">${audioReady?"TAP TO PLAY":"EMPTY"}</span>
      </span>`;

    let pressTimer=null, longPressed=false;
    btn.addEventListener("pointerdown",()=>{
      if (mode !== "owner") return;
      longPressed=false;
      pressTimer=setTimeout(()=>{ longPressed=true; openEditor(index); },650);
    });
    ["pointerup","pointercancel","pointerleave"].forEach(ev=>btn.addEventListener(ev,()=>clearTimeout(pressTimer)));

    btn.addEventListener("click",async()=>{
      if(longPressed) return;
      btn.classList.remove("just-hit"); void btn.offsetWidth; btn.classList.add("just-hit");
      setTimeout(()=>btn.classList.remove("just-hit"),380);
      if(mode === "owner" && editMode) openEditor(index);
      else await playSlot(index,btn);
    });

    btn.addEventListener("dragstart",e=>{
      if (mode !== "owner" || !editMode) return;
      draggedIndex=index; btn.classList.add("dragging"); e.dataTransfer.effectAllowed="move";
    });
    btn.addEventListener("dragend",()=>{
      draggedIndex=null;
      document.querySelectorAll(".pad").forEach(p=>p.classList.remove("dragging","drag-over"));
    });
    btn.addEventListener("dragover",e=>{
      if(mode !== "owner" || !editMode) return;
      e.preventDefault(); btn.classList.add("drag-over");
    });
    btn.addEventListener("dragleave",()=>btn.classList.remove("drag-over"));
    btn.addEventListener("drop",async e=>{
      if(mode !== "owner" || !editMode || draggedIndex===null) return;
      e.preventDefault(); btn.classList.remove("drag-over"); await swapSlots(draggedIndex,index);
    });
    board.appendChild(btn);
  });
}

async function swapSlots(a,b) {
  if(a===b || mode !== "owner") return;
  [slots[a],slots[b]]=[slots[b],slots[a]];
  markDirty(); saveLocalDraft(); render(); showToast("並び替えました");
}

async function playSlot(index,btn) {
  const slot=slots[index];
  if(!hasAudio(slot)) {
    if (mode === "owner") openEditor(index);
    else showToast("このSEはまだ未登録です");
    return;
  }

  let objectUrl="";
  try {
    let src="";
    if (mode === "owner") {
      const localFile=await getAudio(slot.id).catch(()=>null);
      if(localFile && (slot.localDirtyAudio || !slot.remotePath)) {
        objectUrl=URL.createObjectURL(localFile);
        src=objectUrl;
      }
    }
    if(!src && slot.remotePath) src=remoteAudioUrl(slot);
    if(!src && mode === "owner") {
      const localFile=await getAudio(slot.id).catch(()=>null);
      if(localFile) { objectUrl=URL.createObjectURL(localFile); src=objectUrl; }
    }
    if(!src) { showToast("音声データが見つかりません"); return; }

    const audio=new Audio(src);
    audio.dataset.slotIndex=String(index);
    audio.volume=Math.min(1,Number(slot.volume)*Number($("masterVolume").value));
    activeAudios.add(audio); btn.classList.add("playing");
    audio.onended=audio.onerror=()=>{
      activeAudios.delete(audio); btn.classList.remove("playing");
      if(objectUrl) URL.revokeObjectURL(objectUrl);
    };
    await audio.play();
  } catch(err) {
    console.error(err);
    if(objectUrl) URL.revokeObjectURL(objectUrl);
    showToast("再生できませんでした");
  }
}

function stopAll() {
  activeAudios.forEach(a=>{try{a.pause();a.currentTime=0}catch{}});
  activeAudios.clear();
  document.querySelectorAll(".pad.playing").forEach(p=>p.classList.remove("playing"));
  showToast("すべて停止しました");
}

function openEditor(index) {
  if (mode !== "owner") return;
  editingIndex=index; pendingFile=null;
  const slot=slots[index];
  $("editorTitle").textContent=`SE ${String(index+1).padStart(2,"0")} を設定`;
  $("slotName").value=slot.name;
  $("slotEmoji").value=slot.emoji;
  $("slotVolume").value=slot.volume??1;
  $("slotVolumeLabel").textContent=`${Math.round((slot.volume??1)*100)}%`;
  $("slotFile").value="";
  $("currentFileName").textContent=slot.fileName||"未登録";
  selectedColor=slot.color||palette[0];
  selectedShape=slot.shape||shapePattern[index%shapePattern.length];
  renderShapeChoices(); renderColorChoices(); dialog.showModal();
}

function renderShapeChoices() {
  const wrap=$("shapeChoices"); wrap.innerHTML="";
  shapes.forEach(shape=>{
    const b=document.createElement("button"); b.type="button";
    b.className=`shape-choice ${shape.id===selectedShape?"selected":""}`;
    b.innerHTML=`<span class="shape-icon">${shape.icon}</span>${shape.label}`;
    b.addEventListener("click",()=>{selectedShape=shape.id; renderShapeChoices();});
    wrap.appendChild(b);
  });
}

function renderColorChoices() {
  const wrap=$("colorChoices"); wrap.innerHTML="";
  palette.forEach(color=>{
    const b=document.createElement("button"); b.type="button";
    b.className=`color-choice ${color===selectedColor?"selected":""}`;
    b.style.background=color; b.setAttribute("aria-label",color);
    b.addEventListener("click",()=>{selectedColor=color; renderColorChoices();});
    wrap.appendChild(b);
  });
}

async function saveEditor() {
  if(editingIndex===null || mode !== "owner") return;
  const slot=slots[editingIndex];
  slot.name=$("slotName").value.trim();
  slot.emoji=$("slotEmoji").value.trim()||"🎵";
  slot.color=selectedColor;
  slot.shape=selectedShape;
  slot.volume=Number($("slotVolume").value);
  if(pendingFile) {
    try {
      await putAudio(slot.id,pendingFile);
      slot.fileName=pendingFile.name;
      slot.localDirtyAudio=true;
    } catch(err) {
      console.error(err); showToast("音声の保存に失敗しました"); return;
    }
  }
  markDirty(); saveLocalDraft(); render(); dialog.close(); showToast("下書き保存しました ♡");
}

async function clearSlot() {
  if(editingIndex===null || mode !== "owner") return;
  const old=slots[editingIndex];
  await deleteAudio(old.id).catch(()=>{});
  const replacement=freshSlot(editingIndex);
  replacement.id=old.id || newId(editingIndex);
  if(old.remotePath) replacement.deleteRemotePath=old.remotePath;
  slots[editingIndex]=replacement;
  markDirty(); saveLocalDraft(); render(); dialog.close(); showToast("登録を解除しました");
}

function markDirty() {
  dirty=true;
  $("publishStatus").textContent="未公開の変更があります";
  $("publishStatus").className="publish-status dirty";
}

function markPublished() {
  dirty=false;
  $("publishStatus").textContent="☁️ 公開済み";
  $("publishStatus").className="publish-status ok";
}

function setMode(nextMode) {
  mode=nextMode;
  editMode=false;
  document.body.classList.toggle("owner-mode", mode === "owner");
  $("modeBadge").textContent=mode === "owner" ? "👑 オーナーモード" : "👀 視聴者モード";
  $("modeBadge").className=`mode-badge ${mode}`;
  $("ownerAccessBtn").classList.toggle("hidden", mode === "owner");
  $("ownerLogout").classList.toggle("hidden", mode !== "owner");
  $("ownerToolbar").classList.toggle("hidden", mode !== "owner");
  $("resetAll").classList.toggle("hidden", mode !== "owner");
  $("editToggle").classList.remove("active");
  $("editToggle").textContent="✏️ 編集モード";
  $("modeHint").textContent=mode === "owner"
    ? "オーナーモード：編集 → 下書き保存 →『みんなに公開』で全員へ反映します。"
    : "視聴者モード：公開済みのSEをタップして再生できます。";
}

async function enterOwner(token) {
  const result=await validateToken(token);
  if(!result.ok) throw new Error(result.message);
  sessionStorage.setItem(OWNER_TOKEN_KEY, token);
  setMode("owner");

  if(localDraftHasContent()) {
    slots=normalizeSlots(localDraft.slots);
    $("masterVolume").value=localDraft.masterVolume ?? 1;
    showToast("この端末の既存SEを読み込みました");
  } else {
    const shared=await fetchSharedBoard(false);
    slots=shared?.slots ? normalizeSlots(shared.slots) : freshSlots();
  }
  updateMasterLabel();
  markPublished();
  render();
}

async function leaveOwner() {
  sessionStorage.removeItem(OWNER_TOKEN_KEY);
  setMode("viewer");
  dirty=false;
  loadViewerVolume();
  await fetchSharedBoard();
  showToast("視聴者モードに戻りました");
}

async function validateToken(token) {
  if(!token?.trim()) return {ok:false,message:"GitHub Tokenを入力してください"};
  try {
    const res=await fetch(API_BASE, {headers:githubHeaders(token)});
    if(res.status===401) return {ok:false,message:"Tokenが無効です"};
    if(!res.ok) return {ok:false,message:`GitHub接続に失敗しました (${res.status})`};
    const repo=await res.json();
    if(repo.permissions && repo.permissions.push === false) {
      return {ok:false,message:"このTokenには書き込み権限がありません。Contents: Read and write を付けてください"};
    }
    return {ok:true};
  } catch(err) {
    console.error(err);
    return {ok:false,message:"GitHubへ接続できませんでした"};
  }
}

function githubHeaders(token) {
  return {
    "Accept":"application/vnd.github+json",
    "Authorization":`Bearer ${token}`,
    "X-GitHub-Api-Version":"2022-11-28"
  };
}

async function githubGetContent(path, token) {
  const url=`${API_BASE}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(DATA_BRANCH)}&t=${Date.now()}`;
  const res=await fetch(url,{headers:githubHeaders(token),cache:"no-store"});
  if(res.status===404) return null;
  if(!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return await res.json();
}

async function githubPutBase64(path, base64, token, message) {
  const existing=await githubGetContent(path,token);
  const body={message,content:base64,branch:DATA_BRANCH};
  if(existing?.sha) body.sha=existing.sha;
  const res=await fetch(`${API_BASE}/contents/${encodeRepoPath(path)}`,{
    method:"PUT",
    headers:{...githubHeaders(token),"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  if(!res.ok) {
    const info=await res.text().catch(()=>"");
    throw new Error(`GitHub PUT ${path}: ${res.status} ${info.slice(0,160)}`);
  }
  return await res.json();
}

async function githubPutText(path, text, token, message) {
  return githubPutBase64(path, utf8ToBase64(text), token, message);
}

async function githubDeletePath(path, token, message) {
  if(!path) return;
  const existing=await githubGetContent(path,token);
  if(!existing?.sha) return;
  const res=await fetch(`${API_BASE}/contents/${encodeRepoPath(path)}`,{
    method:"DELETE",
    headers:{...githubHeaders(token),"Content-Type":"application/json"},
    body:JSON.stringify({message,sha:existing.sha,branch:DATA_BRANCH})
  });
  if(!res.ok && res.status!==404) throw new Error(`GitHub DELETE ${path}: ${res.status}`);
}

function utf8ToBase64(text) {
  const bytes=new TextEncoder().encode(text);
  let binary="";
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) {
    binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  }
  return btoa(binary);
}

async function fileToBase64(file) {
  const buffer=await file.arrayBuffer();
  const bytes=new Uint8Array(buffer);
  let binary="";
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) {
    binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  }
  return btoa(binary);
}

function inferExtension(file, fileName="") {
  const name=fileName || file?.name || "";
  const match=name.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  if(match) return match[1].replace(/[^a-z0-9]/g,"");
  const type=(file?.type||"").toLowerCase();
  if(type.includes("mpeg")) return "mp3";
  if(type.includes("wav")) return "wav";
  if(type.includes("mp4")) return "m4a";
  if(type.includes("aac")) return "aac";
  if(type.includes("ogg")) return "ogg";
  return "bin";
}

function cleanId(id,index) {
  const cleaned=String(id||"").replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,80);
  return cleaned || `slot-${String(index+1).padStart(2,"0")}`;
}

function publicSlot(slot) {
  const {localDirtyAudio,deleteRemotePath,...clean}=slot;
  return clean;
}

async function publishAll() {
  if(mode !== "owner" || publishing) return;
  const token=sessionStorage.getItem(OWNER_TOKEN_KEY);
  if(!token) { ownerDialog.showModal(); return; }
  if(!confirm("登録したSE音声を公開リポジトリへアップロードし、同じURLを開いた全員が再生できるようにします。公開してよろしいですか？")) return;

  publishing=true;
  $("publishCloud").disabled=true;
  const originalLabel=$("publishCloud").textContent;
  try {
    const valid=await validateToken(token);
    if(!valid.ok) throw new Error(valid.message);

    for(let i=0;i<slots.length;i++) {
      const slot=slots[i];
      $("publishCloud").textContent=`☁️ 公開中 ${i+1}/${SLOT_COUNT}`;

      if(slot.deleteRemotePath) {
        await githubDeletePath(slot.deleteRemotePath,token,`Remove SE ${i+1}`);
        slot.deleteRemotePath="";
        slot.remotePath="";
      }

      const localFile=await getAudio(slot.id).catch(()=>null);
      const needsUpload=!!localFile && (slot.localDirtyAudio || !slot.remotePath);
      if(needsUpload) {
        const ext=inferExtension(localFile,slot.fileName);
        const newPath=`shared/audio/${cleanId(slot.id,i)}.${ext}`;
        const oldPath=slot.remotePath;
        const base64=await fileToBase64(localFile);
        await githubPutBase64(newPath,base64,token,`Publish SE ${i+1}: ${slot.name||slot.fileName||"sound"}`);
        slot.remotePath=newPath;
        slot.localDirtyAudio=false;
        if(oldPath && oldPath!==newPath) await githubDeletePath(oldPath,token,`Remove old SE ${i+1}`);
      }
    }

    sharedUpdatedAt=new Date().toISOString();
    const boardDoc={
      version:4,
      updatedAt:sharedUpdatedAt,
      slots:slots.map(publicSlot)
    };
    await githubPutText(SHARED_BOARD_PATH,JSON.stringify(boardDoc,null,2),token,"Publish shared SE board");
    slots=normalizeSlots(boardDoc.slots);
    saveLocalDraft();
    markPublished();
    $("footerStatus").textContent=`☁️ 公開版：${formatDate(sharedUpdatedAt)}`;
    render();
    showToast("みんなに公開しました！ ☁️💗");
  } catch(err) {
    console.error(err);
    showToast(err.message || "公開に失敗しました");
    $("publishStatus").textContent="公開に失敗しました";
    $("publishStatus").className="publish-status dirty";
  } finally {
    publishing=false;
    $("publishCloud").disabled=false;
    $("publishCloud").textContent=originalLabel;
  }
}

function updateMasterLabel() {
  $("masterVolumeLabel").textContent=`${Math.round(Number($("masterVolume").value)*100)}%`;
}

function loadViewerVolume() {
  const value=Number(localStorage.getItem(VIEWER_VOLUME_KEY));
  $("masterVolume").value=Number.isFinite(value) && value>=0 && value<=1 ? value : 1;
  updateMasterLabel();
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value));
  } catch { return value; }
}

function showToast(message) {
  const t=$("toast");
  t.textContent=message; t.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer=setTimeout(()=>t.classList.remove("show"),2200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

$("ownerAccessBtn").addEventListener("click",()=>{
  $("ownerToken").value=sessionStorage.getItem(OWNER_TOKEN_KEY)||"";
  ownerDialog.showModal();
});

$("ownerConnect").addEventListener("click",async()=>{
  const btn=$("ownerConnect");
  const token=$("ownerToken").value.trim();
  btn.disabled=true; btn.textContent="接続中…";
  try {
    await enterOwner(token);
    ownerDialog.close();
  } catch(err) {
    console.error(err); showToast(err.message||"オーナーログインに失敗しました");
  } finally {
    btn.disabled=false; btn.textContent="🔓 オーナーになる";
  }
});

$("ownerLogout").addEventListener("click",leaveOwner);
$("publishCloud").addEventListener("click",publishAll);

$("editToggle").addEventListener("click",()=>{
  if(mode!=="owner") return;
  editMode=!editMode;
  $("editToggle").classList.toggle("active",editMode);
  $("editToggle").textContent=editMode?"✅ 編集中":"✏️ 編集モード";
  render();
});

$("stopAll").addEventListener("click",stopAll);
$("refreshShared").addEventListener("click",async()=>{
  if(mode === "owner" && dirty && !confirm("未公開の下書きがあります。視聴者向けの公開版を読み直しますか？（下書き自体は端末に残ります）")) return;
  if(mode === "owner") showToast("視聴者モードで最新公開版を確認できます");
  else { await fetchSharedBoard(); showToast("最新の公開SEに更新しました"); }
});

$("masterVolume").addEventListener("input",()=>{
  updateMasterLabel();
  activeAudios.forEach(a=>{
    const idx=Number(a.dataset?.slotIndex);
    if(!Number.isNaN(idx)&&slots[idx]) a.volume=Math.min(1,slots[idx].volume*Number($("masterVolume").value));
  });
});
$("masterVolume").addEventListener("change",()=>{
  if(mode==="owner") saveLocalDraft();
  else localStorage.setItem(VIEWER_VOLUME_KEY,String($("masterVolume").value));
});

$("slotVolume").addEventListener("input",()=>{
  $("slotVolumeLabel").textContent=`${Math.round(Number($("slotVolume").value)*100)}%`;
});
$("slotFile").addEventListener("change",e=>{
  pendingFile=e.target.files?.[0]||null;
  if(pendingFile) $("currentFileName").textContent=pendingFile.name;
});
$("saveSlot").addEventListener("click",saveEditor);
$("deleteSlot").addEventListener("click",clearSlot);

$("resetAll").addEventListener("click",async()=>{
  if(mode!=="owner") return;
  if(!confirm("この端末にある36個の下書き設定とローカル音声を初期化します。公開済みデータは消えません。よろしいですか？")) return;
  stopAll();
  try { const tx=db.transaction(STORE_NAME,"readwrite"); tx.objectStore(STORE_NAME).clear(); } catch {}
  localStorage.removeItem(STORAGE_KEY);
  localDraft={slots:freshSlots(),masterVolume:1};
  slots=freshSlots(); $("masterVolume").value=1; updateMasterLabel(); markDirty(); saveLocalDraft(); render();
  showToast("この端末の下書きを初期化しました");
});

window.addEventListener("contextmenu",e=>{
  if(e.target.closest(".pad")) e.preventDefault();
});

(async function init() {
  loadLocalDraft();
  loadViewerVolume();
  try {
    db=await openDB();
  } catch(err) {
    console.error(err);
    alert("端末内ストレージを利用できません。プライベートモード等をご確認ください。");
  }

  setMode("viewer");
  slots=freshSlots();
  render();
  await fetchSharedBoard();

  const token=sessionStorage.getItem(OWNER_TOKEN_KEY);
  if(token) {
    const result=await validateToken(token);
    if(result.ok) {
      try { await enterOwner(token); } catch {}
    } else {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
    }
  }

  if("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  }
})();
