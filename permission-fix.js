// PON! SE Board v4.1 — owner token permission validation hotfix
// A public repository can return 200 for GET /repos/... even when the PAT has no write access.
// This patch verifies real Contents: write permission with GitHub's Create-a-blob endpoint.

validateToken = async function(token) {
  if (!token?.trim()) {
    return { ok:false, message:"GitHub Tokenを入力してください" };
  }

  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: githubHeaders(token),
      cache: "no-store"
    });

    if (userRes.status === 401) {
      return { ok:false, message:"Tokenが無効です。新しいFine-grained tokenを作成してください。" };
    }
    if (!userRes.ok) {
      return { ok:false, message:`GitHub認証に失敗しました (${userRes.status})` };
    }

    // This endpoint requires repository Contents: write. It creates only an unreferenced
    // tiny Git blob, so it does not change the branch, board, files, or visible commit history.
    const probeRes = await fetch(`${API_BASE}/git/blobs`, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type":"application/json" },
      body: JSON.stringify({
        content: "PON SE Board owner permission check",
        encoding: "utf-8"
      })
    });

    if (probeRes.status === 403 || probeRes.status === 404) {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
      return {
        ok:false,
        message:"このTokenには pon-se-board への書き込み権限がありません。GitHubで Repository access → Only select repositories → pon-se-board、Repository permissions → Contents → Read and write にして、新しいTokenを入力してください。"
      };
    }

    if (!probeRes.ok) {
      const info = await probeRes.text().catch(() => "");
      return {
        ok:false,
        message:`書き込み権限の確認に失敗しました (${probeRes.status}) ${info.slice(0,80)}`
      };
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
    const info = await res.text().catch(() => "");

    if (res.status === 403 && info.includes("Resource not accessible by personal access token")) {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
      throw new Error("GitHub Tokenの書き込み権限が不足しています。pon-se-board を対象にし、Contents を Read and write にしたFine-grained tokenを作り直して、右上の『オーナー』から再入力してください。");
    }

    throw new Error(`GitHub PUT ${path}: ${res.status} ${info.slice(0,160)}`);
  }

  return await res.json();
};

// v4.2 is loaded with a unique URL every page load so older PWA/service-worker caches
// cannot keep the old owner/local-draft behavior alive.
(function loadOwnerSyncV42() {
  const s = document.createElement("script");
  s.src = `./owner-sync-fix.js?v=4.2.0&t=${Date.now()}`;
  s.async = false;
  s.onload = () => {
    const token = sessionStorage.getItem(OWNER_TOKEN_KEY);
    if (token && typeof enterOwner === "function") {
      enterOwner(token).catch(err => console.warn("v4.2 owner refresh failed", err));
    }
  };
  document.head.appendChild(s);
})();
