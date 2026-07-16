import {
  handleMessage,
  getListPage,
  getMonthlyReportForMonth,
  startManageFlow,
  startEditRecord,
  deleteRecordDirect,
  startConfirmDelete,
} from '../../lib/parseExpense';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, userId, listMore, reportMonth, manageSource, editRecordId, deleteRecordId, confirmDeleteId } = req.body;
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