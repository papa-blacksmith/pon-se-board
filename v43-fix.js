// PON! SE Board v4.3 — iPhone media normalization + reliable SVG shapes

const V43_MAX_GITHUB_AUDIO_BYTES = 18 * 1024 * 1024; // conservative for browser/API publishing
const V43_MAX_SOURCE_BYTES = 140 * 1024 * 1024;
const V43_TARGET_SAMPLE_RATE = 22050;

function v43FmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function v43FileExt(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{2,6})$/);
  return m ? m[1] : "";
}

function v43NeedsNormalize(file) {
  const ext = v43FileExt(file?.name);
  const type = String(file?.type || "").toLowerCase();
  return ext === "mov" || type.includes("quicktime") || type.startsWith("video/") || (file?.size || 0) > V43_MAX_GITHUB_AUDIO_BYTES;
}

function v43SafeBaseName(name) {
  return String(name || "sound")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim()
    .slice(0, 80) || "sound";
}

function v43EncodeWav(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function v43NormalizeToWav(file) {
  if (!file) throw new Error("ファイルがありません");
  if (file.size > V43_MAX_SOURCE_BYTES) {
    throw new Error(`元ファイルが大きすぎます（${v43FmtMB(file.size)}）。140MB以下の短いSEを選んでください。`);
  }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !window.OfflineAudioContext) {
    throw new Error("このブラウザでは音声変換を利用できません。MP3 / M4A / WAVを選んでください。");
  }

  const ctx = new Ctx();
  try {
    const sourceBytes = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(sourceBytes.slice(0));
    if (!decoded?.duration || !Number.isFinite(decoded.duration)) {
      throw new Error("音声トラックを読み取れませんでした");
    }
    if (decoded.duration > 8 * 60) {
      throw new Error("SEとして長すぎます。8分以内の音声を選んでください。");
    }

    const frames = Math.max(1, Math.ceil(decoded.duration * V43_TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, V43_TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const wav = v43EncodeWav(rendered);

    if (wav.size > V43_MAX_GITHUB_AUDIO_BYTES) {
      throw new Error(`変換後も${v43FmtMB(wav.size)}あります。もっと短いSEにしてください。`);
    }

    return new File([wav], `${v43SafeBaseName(file.name)}.wav`, {
      type: "audio/wav",
      lastModified: Date.now()
    });
  } catch (err) {
    const ext = v43FileExt(file.name);
    if (ext === "mov" || String(file.type || "").startsWith("video/")) {
      throw new Error(`iPhone動画から音声を取り出せませんでした。短い動画にするか、MP3 / M4A / WAVで保存して選んでください。詳細: ${err.message || err}`);
    }
    throw err;
  } finally {
    try { await ctx.close(); } catch {}
  }
}

async function v43PrepareSelectedMedia(file) {
  const input = document.getElementById("slotFile");
  const save = document.getElementById("saveSlot");
  const label = document.getElementById("currentFileName");

  pendingFile = null;
  if (save) save.disabled = true;

  try {
    if (!file) {
      if (label) label.textContent = "未登録";
      return;
    }

    if (v43NeedsNormalize(file)) {
      if (label) label.textContent = `🎧 iPhone互換へ変換中… ${file.name} (${v43FmtMB(file.size)})`;
      showToast("🎧 音声だけを軽量化しています…");
      const normalized = await v43NormalizeToWav(file);
      pendingFile = normalized;
      if (label) label.textContent = `✅ ${normalized.name} (${v43FmtMB(normalized.size)})`;
      showToast("✅ iPhone用に音声を軽量化しました");
    } else {
      pendingFile = file;
      if (label) label.textContent = `${file.name} (${v43FmtMB(file.size)})`;
    }
  } catch (err) {
    pendingFile = null;
    if (input) input.value = "";
    if (label) label.textContent = "⚠️ このファイルは使用できません";
    showToast(err.message || "音声変換に失敗しました");
    alert(err.message || "音声変換に失敗しました");
  } finally {
    if (save) save.disabled = false;
  }
}

function v43ShapeSvg(shape) {
  if (shape === "heart") {
    return `<svg class="shape-svg" viewBox="0 0 100 100" aria-hidden="true"><path class="shape-main" d="M50 91C41 82 11 65 7 40C4 21 15 9 31 9C41 9 47 15 50 22C53 15 59 9 69 9C85 9 96 21 93 40C89 65 59 82 50 91Z"/><path class="shape-inner" d="M50 84C42 76 18 62 14 41C12 27 20 17 32 17C42 17 47 24 50 31C53 24 58 17 68 17C80 17 88 27 86 41C82 62 58 76 50 84Z"/></svg>`;
  }
  if (shape === "star") {
    return `<svg class="shape-svg" viewBox="0 0 100 100" aria-hidden="true"><path class="shape-main" d="M50 5L61 34L93 35L68 55L77 87L50 69L23 87L32 55L7 35L39 34Z"/><path class="shape-inner" d="M50 17L58 40L82 41L63 56L69 78L50 65L31 78L37 56L18 41L42 40Z"/></svg>`;
  }
  if (shape === "flower") {
    return `<svg class="shape-svg" viewBox="0 0 100 100" aria-hidden="true"><g class="shape-main flower-main"><circle cx="50" cy="20" r="19"/><circle cx="75" cy="31" r="19"/><circle cx="82" cy="57" r="19"/><circle cx="65" cy="78" r="19"/><circle cx="37" cy="80" r="19"/><circle cx="17" cy="61" r="19"/><circle cx="21" cy="34" r="19"/><circle cx="50" cy="52" r="29"/></g><circle class="flower-center" cx="50" cy="52" r="22"/></svg>`;
  }
  return "";
}

// Stable render for Safari/iOS: actual SVG elements instead of CSS masks.
render = function() {
  board.innerHTML = "";
  slots.forEach((slot,index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const shape = slot.shape || shapePattern[index % shapePattern.length];
    const audioReady = hasAudio(slot);
    btn.className = `pad shape-${shape} ${audioReady ? "" : "empty"}`;
    btn.style.setProperty("--pad-color", slot.color);
    btn.draggable = mode === "owner" && editMode;
    btn.dataset.index = index;
    const cloud = slot.remotePath ? `<span class="cloud-mark" title="公開済み">☁️</span>` : "";
    btn.innerHTML = `${pawDecor(shape)}${v43ShapeSvg(shape)}${cloud}
      <span class="pad-number">${String(index+1).padStart(2,"0")}</span>
      <span class="pad-content">
        <span class="pad-emoji">${escapeHtml(slot.emoji || "🎵")}</span>
        <span class="pad-name">${escapeHtml(slot.name || "SEを登録")}</span>
        <span class="pad-sub">${audioReady ? "TAP TO PLAY" : "EMPTY"}</span>
      </span>`;

    let pressTimer = null, longPressed = false;
    btn.addEventListener("pointerdown", () => {
      if (mode !== "owner") return;
      longPressed = false;
      pressTimer = setTimeout(() => { longPressed = true; openEditor(index); }, 650);
    });
    ["pointerup","pointercancel","pointerleave"].forEach(ev => btn.addEventListener(ev, () => clearTimeout(pressTimer)));

    btn.addEventListener("click", async () => {
      if (longPressed) return;
      btn.classList.remove("just-hit"); void btn.offsetWidth; btn.classList.add("just-hit");
      setTimeout(() => btn.classList.remove("just-hit"), 380);
      if (mode === "owner" && editMode) openEditor(index);
      else await playSlot(index, btn);
    });

    btn.addEventListener("dragstart", e => {
      if (mode !== "owner" || !editMode) return;
      draggedIndex = index; btn.classList.add("dragging"); e.dataTransfer.effectAllowed = "move";
    });
    btn.addEventListener("dragend", () => {
      draggedIndex = null;
      document.querySelectorAll(".pad").forEach(p => p.classList.remove("dragging","drag-over"));
    });
    btn.addEventListener("dragover", e => {
      if (mode !== "owner" || !editMode) return;
      e.preventDefault(); btn.classList.add("drag-over");
    });
    btn.addEventListener("dragleave", () => btn.classList.remove("drag-over"));
    btn.addEventListener("drop", async e => {
      if (mode !== "owner" || !editMode || draggedIndex === null) return;
      e.preventDefault(); btn.classList.remove("drag-over"); await swapSlots(draggedIndex,index);
    });
    board.appendChild(btn);
  });
};

// Friendly guard even if an oversized file somehow bypasses the picker preparation.
const v43PreviousGithubPutBase64 = githubPutBase64;
githubPutBase64 = async function(path, base64, token, message) {
  const approxBytes = Math.floor((base64?.length || 0) * 0.75);
  if (approxBytes > V43_MAX_GITHUB_AUDIO_BYTES && path.startsWith("shared/audio/")) {
    throw new Error(`公開するSEが大きすぎます（約${v43FmtMB(approxBytes)}）。iPhoneでは音声ファイルを選び直すと自動軽量化します。`);
  }
  try {
    return await v43PreviousGithubPutBase64(path, base64, token, message);
  } catch (err) {
    const text = String(err?.message || err || "");
    if (text.includes("422") && text.toLowerCase().includes("too large")) {
      throw new Error("GitHubへ送るにはファイルが大きすぎます。iPhoneでは元の動画/音声を選び直してください。自動で音声だけを軽量化します。");
    }
    throw err;
  }
};

(function installV43() {
  const input = document.getElementById("slotFile");
  if (input) {
    input.setAttribute("accept", "audio/*,video/quicktime,.mov,.mp3,.wav,.m4a,.aac,.ogg");
    input.addEventListener("change", e => {
      const file = e.target.files?.[0] || null;
      // app.js listener fires first; overwrite its pendingFile with the normalized result.
      v43PrepareSelectedMedia(file);
    });
  }
  render();
  if (typeof v42UpdateRestoreButton === "function") v42UpdateRestoreButton();
})();
