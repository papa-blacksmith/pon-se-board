// PON! SE Board v4.2 — cloud-first owner mode + safe local restore + GitHub 409 retry

const V42_RETRY_DELAYS = [0, 1500, 3000, 6000, 10000];

function v42Sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function v42IsTransientRuleError(status, text) {
  if (status !== 409) return false;
  const s = String(text || "").toLowerCase();
  return s.includes("timed out validating rule") ||
         s.includes("repository rule violations found") ||
         s.includes("please try again");
}

// Override GitHub upload with retry for transient repository rule validation timeouts.
githubPutBase64 = async function(path, base64, token, message) {
  let lastErrorText = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt < V42_RETRY_DELAYS.length; attempt++) {
    if (V42_RETRY_DELAYS[attempt] > 0) {
      await v42Sleep(V42_RETRY_DELAYS[attempt]);
    }

    const existing = await githubGetContent(path, token);
    const body = { message, content: base64, branch: DATA_BRANCH };
    if (existing?.sha) body.sha = existing.sha;

    const res = await fetch(`${API_BASE}/contents/${encodeRepoPath(path)}`, {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.ok) return await res.json();

    const info = await res.text().catch(() => "");
    lastErrorText = info;
    lastStatus = res.status;

    if (res.status === 403 && info.includes("Resource not accessible by personal access token")) {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
      throw new Error("GitHub Tokenの書き込み権限が不足しています。pon-se-board を対象にし、Contents を Read and write にしたTokenを入力し直してください。");
    }

    if (v42IsTransientRuleError(res.status, info)) {
      const retryNo = attempt + 1;
      if (retryNo < V42_RETRY_DELAYS.length) {
        if (typeof $ === "function" && $("publishStatus")) {
          $("publishStatus").textContent = `GitHub確認待ち… 自動再試行 ${retryNo}/${V42_RETRY_DELAYS.length - 1}`;
          $("publishStatus").className = "publish-status dirty";
        }
        continue;
      }
    }

    throw new Error(`GitHub PUT ${path}: ${res.status} ${info.slice(0, 220)}`);
  }

  throw new Error(`GitHub PUT ${path}: ${lastStatus} ${lastErrorText.slice(0, 220)}`);
};

// Owner mode must always start from the currently published cloud board.
// Local browser draft is preserved, but never imported automatically.
enterOwner = async function(token) {
  const result = await validateToken(token);
  if (!result.ok) throw new Error(result.message);

  sessionStorage.setItem(OWNER_TOKEN_KEY, token);
  setMode("owner");

  const shared = await fetchSharedBoard(false);
  slots = shared?.slots ? normalizeSlots(shared.slots) : freshSlots();

  // Keep the user's current listening volume; do not import local draft volume automatically.
  updateMasterLabel();
  markPublished();
  render();

  v42UpdateRestoreButton();
  showToast(shared?.slots ? "☁️ 公開版を読み込みました" : "☁️ 公開版はまだ空です");
};

async function v42RestoreDeviceDraft() {
  if (mode !== "owner") return;
  if (!localDraftHasContent()) {
    showToast("この端末に復元できる下書きはありません");
    return;
  }

  if (!confirm("この端末に保存されている旧SE/下書きをオーナー編集画面へ読み込みますか？\n\n公開版は『みんなに公開』を押すまで変更されません。")) return;

  slots = normalizeSlots(localDraft.slots);

  // Legacy local-only audio did not always have localDirtyAudio.
  // Mark only actual local files without a cloud path as upload candidates.
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const localFile = await getAudio(slot.id).catch(() => null);
    if (localFile && !slot.remotePath) slot.localDirtyAudio = true;
  }

  if (localDraft.masterVolume != null) {
    $("masterVolume").value = localDraft.masterVolume;
    updateMasterLabel();
  }

  markDirty();
  render();
  showToast("📱 この端末の下書きを復元しました");
}

function v42UpdateRestoreButton() {
  const btn = document.getElementById("restoreLocalDraft");
  if (!btn) return;
  btn.classList.toggle("hidden", mode !== "owner" || !localDraftHasContent());
}

async function v42PublishAll() {
  if (mode !== "owner" || publishing) return;

  const token = sessionStorage.getItem(OWNER_TOKEN_KEY);
  if (!token) {
    ownerDialog.showModal();
    return;
  }

  if (!confirm("編集したSEをクラウドへ反映し、同じURLを開いた全員が再生できるようにします。公開してよろしいですか？")) return;

  publishing = true;
  const publishBtn = $("publishCloud");
  publishBtn.disabled = true;
  const originalLabel = publishBtn.textContent;

  try {
    const valid = await validateToken(token);
    if (!valid.ok) throw new Error(valid.message);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      publishBtn.textContent = `☁️ 公開中 ${i + 1}/${SLOT_COUNT}`;

      if (slot.deleteRemotePath) {
        await githubDeletePath(slot.deleteRemotePath, token, `Remove SE ${i + 1}`);
        slot.deleteRemotePath = "";
        slot.remotePath = "";
      }

      // IMPORTANT: never upload a stale IndexedDB file just because it exists.
      // Only audio explicitly selected in edit mode or explicitly restored from local draft is uploaded.
      if (slot.localDirtyAudio === true) {
        const localFile = await getAudio(slot.id).catch(() => null);
        if (!localFile) {
          throw new Error(`SE ${i + 1}「${slot.name || slot.fileName || "未名称"}」の端末内音声が見つかりません。もう一度音声ファイルを選択してください。`);
        }

        // GitHub Contents API is not a good fit for huge media files.
        if (localFile.size > 90 * 1024 * 1024) {
          throw new Error(`SE ${i + 1} の音声ファイルが大きすぎます（${Math.round(localFile.size / 1024 / 1024)}MB）。90MB未満の音声にしてください。`);
        }

        const ext = inferExtension(localFile, slot.fileName);
        const newPath = `shared/audio/${cleanId(slot.id, i)}.${ext}`;
        const oldPath = slot.remotePath;
        const base64 = await fileToBase64(localFile);

        await githubPutBase64(
          newPath,
          base64,
          token,
          `Publish SE ${i + 1}: ${slot.name || slot.fileName || "sound"}`
        );

        slot.remotePath = newPath;
        slot.localDirtyAudio = false;

        if (oldPath && oldPath !== newPath) {
          await githubDeletePath(oldPath, token, `Remove old SE ${i + 1}`);
        }
      }
    }

    sharedUpdatedAt = new Date().toISOString();
    const boardDoc = {
      version: 4.2,
      updatedAt: sharedUpdatedAt,
      slots: slots.map(publicSlot)
    };

    await githubPutText(
      SHARED_BOARD_PATH,
      JSON.stringify(boardDoc, null, 2),
      token,
      "Publish shared SE board"
    );

    slots = normalizeSlots(boardDoc.slots);
    saveLocalDraft();
    markPublished();
    $("footerStatus").textContent = `☁️ 公開版：${formatDate(sharedUpdatedAt)}`;
    render();
    v42UpdateRestoreButton();
    showToast("みんなに公開しました！ ☁️💗");
  } catch (err) {
    console.error(err);
    showToast(err.message || "公開に失敗しました");
    $("publishStatus").textContent = "公開に失敗しました";
    $("publishStatus").className = "publish-status dirty";
  } finally {
    publishing = false;
    publishBtn.disabled = false;
    publishBtn.textContent = originalLabel;
  }
}

(function installV42OwnerSyncFix() {
  // Add explicit local-draft restore control. Local data is never auto-imported anymore.
  const toolbar = document.getElementById("ownerToolbar");
  const publish = document.getElementById("publishCloud");
  if (toolbar && publish && !document.getElementById("restoreLocalDraft")) {
    const restore = document.createElement("button");
    restore.id = "restoreLocalDraft";
    restore.type = "button";
    restore.className = "pill secondary hidden";
    restore.textContent = "📱 この端末の下書きを復元";
    restore.addEventListener("click", v42RestoreDeviceDraft);
    toolbar.insertBefore(restore, publish);
  }

  // app.js already registered the old publishAll function by reference.
  // Replace the button to remove that legacy listener and install v4.2 behavior only.
  const oldPublish = document.getElementById("publishCloud");
  if (oldPublish) {
    const newPublish = oldPublish.cloneNode(true);
    oldPublish.replaceWith(newPublish);
    newPublish.addEventListener("click", v42PublishAll);
  }

  v42UpdateRestoreButton();
})();
