// PON! SE Board v4.4 — mobile-safe Web Audio volume engine
// iOS Safari may ignore HTMLMediaElement.volume. Route playback through GainNode instead.

let v44AudioContext = null;
let v44MasterGain = null;
const v44ActiveSources = new Set();
const v44DecodedCache = new Map();

function v44CurrentMasterVolume() {
  const el = document.getElementById("masterVolume");
  const value = Number(el?.value ?? 1);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function v44SlotVolume(slot) {
  const value = Number(slot?.volume ?? 1);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

async function v44EnsureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("このブラウザはWeb Audioに対応していません");

  if (!v44AudioContext || v44AudioContext.state === "closed") {
    v44AudioContext = new Ctx();
    v44MasterGain = v44AudioContext.createGain();
    v44MasterGain.gain.value = v44CurrentMasterVolume();
    v44MasterGain.connect(v44AudioContext.destination);
  }

  if (v44AudioContext.state === "suspended") {
    await v44AudioContext.resume();
  }

  if (v44MasterGain) v44MasterGain.gain.value = v44CurrentMasterVolume();
  return v44AudioContext;
}

async function v44ResolveAudioBytes(index, slot) {
  if (mode === "owner") {
    const localFile = await getAudio(slot.id).catch(() => null);
    if (localFile && (slot.localDirtyAudio === true || !slot.remotePath)) {
      return {
        key: `local:${slot.id}:${localFile.size}:${localFile.lastModified || 0}`,
        buffer: await localFile.arrayBuffer()
      };
    }
  }

  if (slot.remotePath) {
    const url = remoteAudioUrl(slot);
    const res = await fetch(url, { cache:"force-cache" });
    if (!res.ok) throw new Error(`音声取得に失敗しました (${res.status})`);
    return { key:`remote:${url}`, buffer:await res.arrayBuffer() };
  }

  if (mode === "owner") {
    const localFile = await getAudio(slot.id).catch(() => null);
    if (localFile) {
      return {
        key: `local:${slot.id}:${localFile.size}:${localFile.lastModified || 0}`,
        buffer: await localFile.arrayBuffer()
      };
    }
  }

  throw new Error("音声データが見つかりません");
}

async function v44GetDecodedBuffer(index, slot) {
  const ctx = await v44EnsureAudioContext();
  const resolved = await v44ResolveAudioBytes(index, slot);

  if (v44DecodedCache.has(resolved.key)) return v44DecodedCache.get(resolved.key);

  const decoded = await ctx.decodeAudioData(resolved.buffer.slice(0));
  v44DecodedCache.set(resolved.key, decoded);

  // Bound memory on phones/tablets.
  while (v44DecodedCache.size > 18) {
    const firstKey = v44DecodedCache.keys().next().value;
    v44DecodedCache.delete(firstKey);
  }

  return decoded;
}

function v44StopEntry(entry) {
  if (!entry || entry.stopped) return;
  entry.stopped = true;
  try { entry.source.stop(0); } catch {}
  try { entry.source.disconnect(); } catch {}
  try { entry.gain.disconnect(); } catch {}
  if (entry.button) entry.button.classList.remove("playing");
  v44ActiveSources.delete(entry);
}

function v44StopAll() {
  [...v44ActiveSources].forEach(v44StopEntry);
}

// Override playback used by both the original renderer and v4.3 SVG renderer.
playSlot = async function(index, btn) {
  const slot = slots[index];
  if (!hasAudio(slot)) {
    if (mode === "owner") openEditor(index);
    else showToast("このSEはまだ未登録です");
    return;
  }

  try {
    // Resume immediately from the tap gesture before any network/IndexedDB await.
    const ctx = await v44EnsureAudioContext();
    const decoded = await v44GetDecodedBuffer(index, slot);

    const source = ctx.createBufferSource();
    const slotGain = ctx.createGain();
    source.buffer = decoded;
    slotGain.gain.value = v44SlotVolume(slot);

    source.connect(slotGain);
    slotGain.connect(v44MasterGain);

    const entry = { source, gain:slotGain, index, button:btn, stopped:false };
    v44ActiveSources.add(entry);
    if (btn) btn.classList.add("playing");

    source.onended = () => {
      if (entry.stopped) return;
      entry.stopped = true;
      try { source.disconnect(); } catch {}
      try { slotGain.disconnect(); } catch {}
      v44ActiveSources.delete(entry);
      if (btn) btn.classList.remove("playing");
    };

    source.start(0);
  } catch (err) {
    console.error("v4.4 playback failed", err);
    showToast(err?.message || "再生できませんでした");
  }
};

(function installV44MobileAudio() {
  const master = document.getElementById("masterVolume");
  const stop = document.getElementById("stopAll");
  const slotVolume = document.getElementById("slotVolume");

  const applyMaster = () => {
    const value = v44CurrentMasterVolume();
    if (v44MasterGain) {
      try {
        v44MasterGain.gain.cancelScheduledValues(v44AudioContext?.currentTime || 0);
        v44MasterGain.gain.setValueAtTime(value, v44AudioContext?.currentTime || 0);
      } catch {
        v44MasterGain.gain.value = value;
      }
    }
  };

  if (master) {
    master.addEventListener("input", applyMaster, { passive:true });
    master.addEventListener("change", applyMaster, { passive:true });
  }

  if (slotVolume) {
    slotVolume.addEventListener("input", () => {
      if (editingIndex == null) return;
      const value = Math.max(0, Math.min(1, Number(slotVolume.value || 0)));
      for (const entry of v44ActiveSources) {
        if (entry.index === editingIndex) {
          try { entry.gain.gain.value = value; } catch {}
        }
      }
    }, { passive:true });
  }

  // The old stop handler still runs too; this one stops Web Audio sources.
  if (stop) stop.addEventListener("click", v44StopAll);

  // Unlock/resume Web Audio on first user interaction. Safe no-op afterwards.
  const unlock = () => {
    v44EnsureAudioContext().catch(() => {});
  };
  document.addEventListener("touchstart", unlock, { passive:true, once:true });
  document.addEventListener("pointerdown", unlock, { passive:true, once:true });

  window.addEventListener("pageshow", () => {
    if (v44MasterGain) v44MasterGain.gain.value = v44CurrentMasterVolume();
  });

  console.info("PON! SE Board v4.4 mobile audio engine active");
})();
