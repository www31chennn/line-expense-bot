import {
  handleMessage,
  getListPage,
  getMonthlyReportForMonth,
  startManageFlow,
  startEditRecord,
  deleteRecordDirect,
  startConfirmDelete,
  toggleCategoryEnabled,
  startCategoryActionMenu,
  startCategoryEmojiEdit,
  startCategoryRename,
  startAddCategory,
  undoRecords,
  applyCategoryPercentDirect,
  getPendingAction,
  clearPendingAction,
  getCategorySettingsMore,
} from '../../lib/parseExpense';

export default async function handler(req, res) {
  // 安全防護：這個端點接受任意 userId、能對任何使用者的帳本讀寫刪，
  // 部署到正式環境後絕不能公開。production 一律拒絕，除非明確設了 ALLOW_TEST_PAGE=true
  // （本機 npm run dev 的 NODE_ENV 是 development，不受影響）
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_PAGE !== 'true') {
    return res.status(405).json({ error: 'test-parse 在正式環境停用（要開放請設環境變數 ALLOW_TEST_PAGE=true）' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    message,
    userId,
    listMore,
    reportMonth,
    manageSource,
    editRecordId,
    deleteRecordId,
    confirmDeleteId,
    toggleCategoryName,
    categoryMenuName,
    startCategoryEmojiName,
    startCategoryRenameName,
    startAddCategoryFlag,
    undoRecordIds,
    confirmCalcPct,
    confirmCalcCategory,
    confirmCalcPctValue,
    categorySettingsMoreOffset,
  } = req.body;
  const uid = userId || 'test-user';

  try {
    if (listMore) {
      const result = await getListPage(uid, listMore.category, listMore.startDate, listMore.endDate, listMore.offset);
      return res.status(200).json({ type: 'list', ...result });
    }

    if (reportMonth) {
      const result = await getMonthlyReportForMonth(uid, reportMonth, Date.now());
      return res.status(200).json({ type: 'monthly_report', ...result });
    }

    if (manageSource) {
      const result = await startManageFlow(uid, manageSource);
      return res.status(200).json(result);
    }

    if (editRecordId) {
      const result = await startEditRecord(uid, editRecordId);
      return res.status(200).json(result);
    }

    if (confirmDeleteId) {
      const result = await startConfirmDelete(uid, confirmDeleteId);
      return res.status(200).json(result);
    }

    if (deleteRecordId) {
      const result = await deleteRecordDirect(uid, deleteRecordId);
      return res.status(200).json(result);
    }

    if (toggleCategoryName) {
      const result = await toggleCategoryEnabled(uid, toggleCategoryName);
      return res.status(200).json(result);
    }

    if (categoryMenuName) {
      const result = await startCategoryActionMenu(uid, categoryMenuName);
      return res.status(200).json(result);
    }

    if (confirmCalcPct) {
      // category/pct 直接從參數讀，不依賴 pendingAction
      if (!confirmCalcCategory || !confirmCalcPctValue) {
        return res.status(200).json({ type: 'calc_category_pct_confirmed', notFound: true });
      }
      const pct = parseInt(confirmCalcPctValue, 10);
      const applyResult = await applyCategoryPercentDirect(uid, confirmCalcCategory, pct);
      return res.status(200).json({ type: 'calc_category_pct_confirmed', category: confirmCalcCategory, pct, ...applyResult });
    }

    if (undoRecordIds) {
      const result = await undoRecords(uid, undoRecordIds);
      return res.status(200).json(result);
    }

    if (startAddCategoryFlag) {
      const result = await startAddCategory(uid);
      return res.status(200).json(result);
    }

    if (startCategoryEmojiName) {
      const result = await startCategoryEmojiEdit(uid, startCategoryEmojiName);
      return res.status(200).json(result);
    }

    if (startCategoryRenameName) {
      const result = await startCategoryRename(uid, startCategoryRenameName);
      return res.status(200).json(result);
    }

    if (categorySettingsMoreOffset != null) {
      const result = await getCategorySettingsMore(uid, categorySettingsMoreOffset);
      return res.status(200).json(result);
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    const result = await handleMessage(uid, message, Date.now());
    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
}