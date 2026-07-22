// 驗證從 LIFF 頁面送回來的 ID Token，確認操作的人「真的是誰」。
//
// 這是為了不要重蹈 export.js / 已刪除的 monthly-report.js 那種「userId 當通行證」的
// 安全洞：前端不能自己宣稱「我是 userId=xxx」，一定要讓 LINE 平台簽發、
// 後端向 LINE 驗證過的 token 才算數。
//
// 前提（設定時務必注意，這步錯了整個驗證會失敗或對到錯的人）：
// LIFF App 現在只能加在「LINE Login Channel」底下（LINE 從 2020 年起不再允許加在
// Messaging API Channel），所以這裡驗證用的 client_id 是 LINE Login Channel 的
// Channel ID，不是 Messaging API 那個。而且這個 LINE Login Channel 必須在它的
// 「Basic settings -> Linked OA」設定裡連結到你的 Messaging API 官方帳號，
// 這樣驗證出來的 sub（LINE userId）才會跟聊天機器人平常用的是同一個。
// 細節見 README 的 LIFF 設定章節。
export async function verifyLiffIdToken(idToken) {
  if (!idToken) {
    return { ok: false, error: '缺少身分驗證資訊，請重新從 LINE 開啟這個頁面' };
  }
  const clientId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!clientId) {
    return { ok: false, error: '伺服器尚未設定 LINE_LOGIN_CHANNEL_ID，無法驗證身分' };
  }

  let res;
  try {
    res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
    });
  } catch (err) {
    return { ok: false, error: '無法連線到 LINE 驗證服務，請稍後再試' };
  }

  if (!res.ok) {
    return { ok: false, error: '身分驗證失敗，token 可能已過期，請重新從 LINE 開啟這個頁面' };
  }

  const data = await res.json();
  if (!data.sub) {
    return { ok: false, error: '驗證回應缺少使用者資訊' };
  }
  return { ok: true, userId: data.sub };
}