import {
  getCategoryConfig,
  buildCategoryDefs,
  activeCategoryNames,
} from '../../../lib/categories';
import { getBudget, setCategoryBudgets, normalizeAllocation, suggestCategoryAllocation } from '../../../lib/parseExpense';
import { verifyLiffIdToken } from '../../../lib/lineAuth';

// 這支 API 只服務 LIFF 頁面，身分一律要驗證過才能用，不接受前端直接指定 userId
// （跟 export.js／被刪除的 monthly-report.js 那種 userId-as-token 不同）。
//
// 唯一例外：非 production 環境下，帶 x-dev-user-id header 可以跳過 ID Token 驗證，
// 直接指定 userId——方便本機開發時不用真的走 LIFF 登入流程就能看畫面。
// NODE_ENV 是 next build/Vercel 自動設定的，不是使用者可調的環境變數，
// 正式環境不可能被觸發，不會重開身分驗證的洞。
async function resolveUserId(req) {
  if (process.env.NODE_ENV !== 'production') {
    const devUserId = req.headers['x-dev-user-id'];
    if (devUserId) return { ok: true, userId: devUserId };
  }
  const idToken = req.headers['x-liff-id-token'];
  const auth = await verifyLiffIdToken(idToken);
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, userId: auth.userId };
}

export default async function handler(req, res) {
  const auth = await resolveUserId(req);
  if (!auth.ok) {
    return res.status(401).json({ error: auth.error });
  }
  const userId = auth.userId;

  if (req.method === 'GET') {
    try {
      const cfg = await getCategoryConfig(userId);
      const active = activeCategoryNames(cfg);
      const defs = buildCategoryDefs(cfg).filter((d) => d.enabled);
      const budget = await getBudget(userId);

      // ?suggest=1：「自動分配」按鈕用，純粹依分類名稱給比例，不讀花費紀錄、不寫入任何東西，
      // 回傳格式跟平常讀取一樣，前端可以直接重用同一套處理邏輯把數字填進畫面
      const allocation = req.query.suggest
        ? suggestCategoryAllocation(active)
        : normalizeAllocation(budget && budget.categoryAllocation, active);

      const categories = defs.map((d) => ({
        name: d.name,
        emoji: d.emoji,
        color: d.color,
        percentage: allocation[d.name] ?? 0,
      }));
      return res.status(200).json({
        categories,
        monthlyLimit: (budget && budget.monthlyLimit) || null,
      });
    } catch (err) {
      return res.status(500).json({ error: '讀取失敗，請稍後再試' });
    }
  }

  if (req.method === 'POST') {
    const { allocation } = req.body || {};
    if (!allocation || typeof allocation !== 'object') {
      return res.status(400).json({ error: '缺少比例資料' });
    }

    // 送出的分類集合必須「剛好等於」目前所有啟用中的分類——
    // 防止頁面開著沒關、期間分類被新增/停用，結果拿舊清單蓋掉新狀態
    const cfg = await getCategoryConfig(userId);
    const active = activeCategoryNames(cfg);
    const submittedNames = Object.keys(allocation);
    const sameSet =
      submittedNames.length === active.length && active.every((name) => submittedNames.includes(name));
    if (!sameSet) {
      return res.status(409).json({ error: '分類清單已經變更過，請重新整理頁面再試一次' });
    }

    const sum = Object.values(allocation).reduce((s, v) => s + (Number(v) || 0), 0);
    if (sum !== 100) {
      return res.status(400).json({ error: `總和必須是 100%（目前 ${sum}%）` });
    }

    // 把所有啟用分類一次送進去，setCategoryBudgets 內建「全部分類都指定時，
    // 必須剛好100%才直接寫入」的邏輯，剛好符合這裡的需求，不用另外寫一份
    const adjustments = active.map((name) => ({ category: name, percentage: allocation[name] }));
    const result = await setCategoryBudgets(userId, adjustments);
    if (result.allSpecifiedMismatch || result.tooMuch) {
      return res.status(400).json({ error: `總和必須是 100%（目前 ${result.specifiedSum}%）` });
    }
    if (result.invalid) {
      return res.status(400).json({ error: '包含不存在的分類，請重新整理頁面再試一次' });
    }

    return res.status(200).json({ ok: true, allocation: result.allocation });
  }

  return res.status(405).json({ error: 'method not allowed' });
}