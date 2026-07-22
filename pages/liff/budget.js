import { useEffect, useState, useCallback } from 'react';

// 這個頁面只能透過 LINE 裡的按鈕開啟（LIFF webview），直接用瀏覽器打開會因為拿不到
// 有效的 ID Token 而卡在「請從 LINE 開啟」畫面——這是設計上刻意的限制，不是 bug。
//
// 本機開發例外：網址帶 ?devUser=test-user 可以跳過整個 LIFF 登入流程，直接指定 userId
// 打 API 看畫面（例如搭配 npm run test-data seed test-user ... 灌的假資料）。
// 這條路徑只在 NODE_ENV !== 'production' 時生效，且 NODE_ENV 是 next build/Vercel
// 自動設定的，不是使用者可調的環境變數，正式環境不可能被觸發，不會重開身分驗證的洞。

const BG = '#FAF7F2';
const CARD_BG = '#FFFFFF';
const CARD_BORDER = '#E5E5E5';
const BRAND = '#5B7F76';
const BRAND_DEEP = '#3F5A52';
const INCOMPLETE = '#B8860B';
const TEXT = '#232323';
const SUBTLE = '#8A8A8A';

export default function LiffBudgetPage() {
  const [phase, setPhase] = useState('loading'); // loading | ready | error | saving | saved
  const [error, setError] = useState('');
  const [authHeaders, setAuthHeaders] = useState(null);
  const [devMode, setDevMode] = useState(null); // devUser 字串，非開發模式為 null
  const [categories, setCategories] = useState([]); // [{name,emoji,color,percentage}]
  const [monthlyLimit, setMonthlyLimit] = useState(null);
  const [values, setValues] = useState({}); // {name: number}
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const params = new URLSearchParams(window.location.search);
        const devUser = params.get('devUser');
        const isDev = process.env.NODE_ENV !== 'production';

        let headers;
        if (isDev && devUser) {
          headers = { 'x-dev-user-id': devUser };
          setDevMode(devUser);
        } else {
          const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
          if (!liffId) {
            setError('這個功能還沒設定完成，麻煩跟開發者說一聲');
            setPhase('error');
            return;
          }
          const liff = (await import('@line/liff')).default;
          await liff.init({ liffId });
          if (!liff.isLoggedIn()) {
            liff.login();
            return; // login() 會導頁，之後重新載入頁面
          }
          const token = liff.getIDToken();
          if (!token) {
            setError('無法取得身分驗證資訊，請從 LINE 聊天室的按鈕重新開啟這個頁面');
            setPhase('error');
            return;
          }
          if (cancelled) return;
          headers = { 'x-liff-id-token': token };
        }
        if (cancelled) return;
        setAuthHeaders(headers);

        const res = await fetch('/api/liff/budget', { headers });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || '讀取失敗');
          setPhase('error');
          return;
        }
        setCategories(data.categories);
        setMonthlyLimit(data.monthlyLimit);
        const initialValues = {};
        data.categories.forEach((c) => {
          initialValues[c.name] = c.percentage;
        });
        setValues(initialValues);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setError('這個頁面只能從 LINE 聊天室裡開啟，請點機器人訊息裡的按鈕進來');
        setPhase('error');
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = Object.values(values).reduce((s, v) => s + (Number(v) || 0), 0);
  const isComplete = total === 100;

  const updateValue = useCallback((name, next) => {
    const clamped = Math.max(0, Math.min(100, Math.round(next) || 0));
    setValues((prev) => ({ ...prev, [name]: clamped }));
  }, []);

  const [savedToast, setSavedToast] = useState(false);

  async function handleAutoDistribute() {
    if (!authHeaders || suggesting) return;
    setSuggesting(true);
    setError('');
    try {
      const res = await fetch('/api/liff/budget?suggest=1', { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '自動分配失敗');
        return;
      }
      const next = {};
      data.categories.forEach((c) => {
        next[c.name] = c.percentage;
      });
      setValues(next);
    } catch (err) {
      setError('網路錯誤，請稍後再試');
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSave() {
    if (!isComplete || !authHeaders) return;
    setPhase('saving');
    setError('');
    try {
      const res = await fetch('/api/liff/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ allocation: values }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '儲存失敗');
        setPhase('ready');
        return;
      }
      // 留在編輯畫面而不是跳到終點畫面，讓使用者可以馬上繼續調整、重複儲存；
      // 用短暫的提示條代替，2.5秒後自動消失
      setPhase('ready');
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2500);
    } catch (err) {
      setError('網路錯誤，請稍後再試');
      setPhase('ready');
    }
  }

  if (phase === 'loading') {
    return (
      <div style={styles.centerScreen}>
        <div style={{ color: SUBTLE, fontSize: 14 }}>載入中…</div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div style={styles.centerScreen}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <div style={{ color: TEXT, fontSize: 15, textAlign: 'center', lineHeight: 1.6, padding: '0 24px' }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {devMode && (
        <div style={styles.devBanner}>🛠️ 開發模式（devUser={devMode}）——這不是真實的 LIFF 登入流程</div>
      )}
      {savedToast && <div style={styles.savedToast}>✅ 已儲存</div>}
      {/* 頂部固定摘要：這是整頁的「儀表」——堆疊色條 + 總和數字，跟聊天機器人月報表卡
          用的是同一套視覺語言（同樣的分類顏色），讓這個頁面感覺是同一個產品的延伸，
          而不是另外做了一個不相干的網頁 */}
      <div style={styles.summaryBar}>
        <div style={styles.summaryTitleRow}>
          <span style={{ fontSize: 13, color: SUBTLE }}>分類比例設定</span>
          <button type="button" style={styles.autoBtn} onClick={handleAutoDistribute} disabled={suggesting}>
            {suggesting ? '分配中…' : '🪄 自動分配'}
          </button>
        </div>
        <div style={styles.stackedBar}>
          {categories.map((c) => {
            const pct = values[c.name] || 0;
            if (pct <= 0) return null;
            return (
              <div
                key={c.name}
                style={{
                  width: `${pct}%`,
                  backgroundColor: c.color,
                  transition: 'width 120ms ease',
                }}
                title={`${c.name} ${pct}%`}
              />
            );
          })}
        </div>
        <div style={styles.totalRow}>
          <span
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: isComplete ? BRAND_DEEP : INCOMPLETE,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {total}%
          </span>
          <span style={{ fontSize: 12, color: isComplete ? BRAND_DEEP : INCOMPLETE, fontWeight: 600 }}>
            {isComplete ? '剛好100%' : total > 100 ? `超過100%了，少${total - 100}%` : `還差${100 - total}%`}
          </span>
        </div>
      </div>

      {!monthlyLimit && (
        <div style={styles.noteBanner}>還沒設定薪水，比例可以先調整</div>
      )}

      {categories.some((c) => (values[c.name] || 0) === 0) && (
        <div style={styles.attentionBanner}>🟡「待設定」的分類還是0%，記得分配</div>
      )}

      <div style={styles.list}>
        {categories.map((c) => {
          const pct = values[c.name] || 0;
          const amount = monthlyLimit ? Math.round((monthlyLimit * pct) / 100) : null;
          const needsAttention = pct === 0;
          return (
            <div key={c.name} style={needsAttention ? styles.rowAttention : styles.row}>
              <div style={styles.rowLeft}>
                <span style={{ fontSize: 20 }}>{c.emoji}</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>
                    {c.name}
                    {needsAttention && <span style={styles.attentionBadge}>待設定</span>}
                  </div>
                  {amount != null && <div style={{ fontSize: 12, color: SUBTLE }}>約 ${amount}</div>}
                </div>
              </div>
              <div style={styles.rowRight}>
                <button
                  type="button"
                  aria-label={`${c.name} 減少`}
                  style={styles.stepBtn}
                  onClick={() => updateValue(c.name, pct - 1)}
                >
                  −
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  value={pct}
                  onChange={(e) => updateValue(c.name, parseInt(e.target.value, 10))}
                  style={styles.numInput}
                  aria-label={`${c.name} 比例`}
                />
                <span style={{ fontSize: 13, color: SUBTLE }}>%</span>
                <button
                  type="button"
                  aria-label={`${c.name} 增加`}
                  style={styles.stepBtn}
                  onClick={() => updateValue(c.name, pct + 1)}
                >
                  ＋
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <div style={styles.saveBar}>
        <button
          type="button"
          disabled={!isComplete || phase === 'saving'}
          onClick={handleSave}
          style={{
            ...styles.saveBtn,
            backgroundColor: isComplete ? BRAND : '#CCCCCC',
            cursor: isComplete ? 'pointer' : 'not-allowed',
          }}
        >
          {phase === 'saving' ? '儲存中…' : isComplete ? '儲存比例' : `未滿 100%（還差 ${Math.max(0, 100 - total)}%）`}
        </button>
      </div>
    </div>
  );
}

const styles = {
  savedToast: {
    position: 'fixed',
    left: 20,
    right: 20,
    bottom: 'calc(76px + env(safe-area-inset-bottom))',
    zIndex: 20,
    background: '#3F5A52',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 700,
    textAlign: 'center',
    padding: '10px 14px',
    borderRadius: 10,
    boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
  },
  devBanner: {
    background: '#2F2F2F',
    color: '#FFD166',
    fontSize: 12,
    padding: '6px 14px',
    textAlign: 'center',
    fontWeight: 600,
  },
  page: {
    minHeight: '100vh',
    background: BG,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif',
    paddingBottom: 96,
  },
  centerScreen: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: BG,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif',
  },
  summaryBar: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    background: CARD_BG,
    borderBottom: `1px solid ${CARD_BORDER}`,
    padding: '16px 20px',
  },
  summaryTitleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  autoBtn: {
    border: `1px solid ${BRAND}`,
    background: 'transparent',
    color: BRAND,
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 8,
    padding: '4px 10px',
    cursor: 'pointer',
  },
  stackedBar: {
    display: 'flex',
    width: '100%',
    height: 10,
    borderRadius: 6,
    overflow: 'hidden',
    background: '#EEEBE4',
    marginBottom: 10,
  },
  totalRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
  },
  noteBanner: {
    margin: '12px 20px 0',
    padding: '10px 14px',
    background: '#FCF3D9',
    color: '#8A6D1D',
    fontSize: 12.5,
    borderRadius: 8,
    lineHeight: 1.6,
  },
  attentionBanner: {
    margin: '12px 20px 0',
    padding: '10px 14px',
    background: '#FCF6E8',
    color: '#8A6D1D',
    fontSize: 12.5,
    borderRadius: 8,
    lineHeight: 1.6,
  },
  list: {
    padding: '12px 20px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: CARD_BG,
    border: `1px solid ${CARD_BORDER}`,
    borderRadius: 12,
    padding: '12px 14px',
  },
  rowAttention: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: '#FCF6E8',
    border: `1px solid #E8D9A8`,
    borderRadius: 12,
    padding: '12px 14px',
  },
  attentionBadge: {
    display: 'inline-block',
    marginLeft: 6,
    fontSize: 10,
    fontWeight: 700,
    color: INCOMPLETE,
    background: '#FCEFCF',
    borderRadius: 6,
    padding: '1px 6px',
    verticalAlign: 'middle',
  },
  rowLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  rowRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: `1px solid ${CARD_BORDER}`,
    background: '#FAFAFA',
    fontSize: 16,
    color: TEXT,
    cursor: 'pointer',
  },
  numInput: {
    width: 46,
    height: 32,
    textAlign: 'center',
    border: `1px solid ${CARD_BORDER}`,
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 700,
    color: TEXT,
  },
  errorBanner: {
    margin: '16px 20px 0',
    padding: '10px 14px',
    background: '#FCEAEA',
    color: '#B03A3A',
    fontSize: 13,
    borderRadius: 8,
    lineHeight: 1.6,
  },
  saveBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '12px 20px calc(12px + env(safe-area-inset-bottom))',
    background: CARD_BG,
    borderTop: `1px solid ${CARD_BORDER}`,
  },
  saveBtn: {
    width: '100%',
    height: 48,
    borderRadius: 10,
    border: 'none',
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 700,
  },
};