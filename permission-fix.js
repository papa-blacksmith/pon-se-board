// PON! SE Board v4.4 — owner permission validation + ordered compatibility loader

validateToken = async function(token) {
  if (!token?.trim()) return { ok:false, message:"GitHub Tokenを入力してください" };

  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: githubHeaders(token), cache:"no-store"
    });
    if (userRes.status === 401) return { ok:false, message:"Tokenが無効です。新しいFine-grained tokenを作成してください。" };
    if (!userRes.ok) return { ok:false, message:`GitHub認証に失敗しました (${userRes.status})` };

    const probeRes = await fetch(`${API_BASE}/git/blobs`, {
      method:"POST",
      headers:{ ...githubHeaders(token), "Content-Type":"application/json" },
      body:JSON.stringify({ content:"PON SE Board owner permission check", encoding:"utf-8" })
    });

    if (probeRes.status === 403 || probeRes.status === 404) {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
      return {
        ok:false,
        message:"このTokenには pon-se-board への書き込み権限がありません。Repository access → pon-se-board、Repository permissions → Contents → Read and write にしてください。"
      };
    }
    if (!probeRes.ok) {
      const info = await probeRes.text().catch(()=>"");
      return { ok:false, message:`書き込み権限の確認に失敗しました (${probeRes.status}) ${info.slice(0,80)}` };
    }
    return { ok:true };
  } catch (err) {
    console.error(err);
    return { ok:false, message:"GitHubへ接続できませんでした" };
  }
};

githubPutBase64 = async function(path, base64, token, message) {
  const existing = await githubGetContent(path, token);
  const body = { message, content:base64, branch:DATA_BRANCH };
  if (existing?.sha) body.sha = existing.sha;

  const res = await fetch(`${API_BASE}/contents/${encodeRepoPath(path)}`, {
    method:"PUT",
    headers:{ ...githubHeaders(token), "Content-Type":"application/json" },
    body:JSON.stringify(body)
  });

  if (!res.ok) {
    const info = await res.text().catch(()=>"");
    if (res.status === 403 && info.includes("Resource not accessible by personal access token")) {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
      throw new Error("GitHub Tokenの書き込み権限が不足しています。ContentsをRead and writeにしたTokenを入力し直してください。");
    }
    throw new Error(`GitHub PUT ${path}: ${res.status} ${info.slice(0,180)}`);
  }
  return await res.json();
};

(function loadV44Fixes() {
  const loadScript = src => new Promise((resolve,reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  (async () => {
    try {
      // Order matters: cloud sync -> iPhone file/SVG fixes -> Web Audio volume engine.
      await loadScript(`./owner-sync-fix.js?v=4.4.0&t=${Date.now()}`);
      await loadScript(`./v43-fix.js?v=4.4.0&t=${Date.now()}`);
      await loadScript(`./v44-mobile-audio.js?v=4.4.0&t=${Date.now()}`);

      const token = sessionStorage.getItem(OWNER_TOKEN_KEY);
      if (token && typeof enterOwner === "function") {
        await enterOwner(token).catch(err => console.warn("v4.4 owner refresh failed", err));
      }
    } catch (err) {
      console.error("v4.4 compatibility load failed", err);
    }
  })();
})();
