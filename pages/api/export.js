import { getAllMatchingRecords } from '../../lib/parseExpense';

function escapeCsvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 分類的英文代稱，只用在檔名（跨系統相容，避免中文檔名在某些瀏覽器/OS下亂碼）
const CATEGORY_SLUG = {
  飲食: 'food',
  交通: 'transport',
  購物: 'shopping',
  娛樂: 'entertainment',
  醫療: 'medical',
  居家: 'home',
  固定支出: 'fixed',
  其他: 'other',
};

function buildFilename(category, start, end) {
  const catPart = category ? CATEGORY_SLUG[category] || 'category' : 'all';
  const rangePart = start && end ? `${start}_to_${end}` : start ? `from_${start}` : end ? `until_${end}` : 'all-time';
  return `expenses_${catPart}_${rangePart}.csv`;
}

export default async function handler(req, res) {
  const { userId, category, start, end } = req.query;
  if (!userId) {
    return res.status(400).send('missing userId');
  }

  try {
    const records = await getAllMatchingRecords(
      userId,
      category || null,
      start || null,
      end || null
    );

    const header = ['日期', '品項', '金額', '分類', '備註'];
    const rows = records.map((r) => [r.date, r.item, r.amount, r.category, r.note || '']);
    const csv = [header, ...rows].map((row) => row.map(escapeCsvField).join(',')).join('\r\n');

    // 開頭加 BOM，讓 Excel 開啟時中文不會變亂碼
    const bom = '\uFEFF';
    const filename = buildFilename(category || null, start || null, end || null);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(bom + csv);
  } catch (err) {
    console.error(err);
    return res.status(500).send('export failed');
  }
}