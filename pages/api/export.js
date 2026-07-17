import { getAllMatchingRecords } from '../../lib/parseExpense';
import { BUILTIN_SLUG } from '../../lib/categories';

function escapeCsvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 分類的英文代稱，只用在「不支援 UTF-8 檔名」的舊瀏覽器 fallback；自訂分類沒有對照，退回通用字樣
function categorySlug(category) {
  if (!category) return 'all';
  return BUILTIN_SLUG[category] || 'category';
}

function buildFilename(category, start, end) {
  const catPart = categorySlug(category);
  const rangePart = start && end ? `${start}_to_${end}` : start ? `from_${start}` : end ? `until_${end}` : 'all-time';
  return `expenses_${catPart}_${rangePart}.csv`;
}

// 自訂分類是中文，直接放進檔名對現代瀏覽器沒問題；這個當作好看版檔名（配合 filename* 使用）
function buildPrettyFilename(category, start, end) {
  const catPart = category || 'all';
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
    const asciiFilename = buildFilename(category || null, start || null, end || null);
    const prettyFilename = buildPrettyFilename(category || null, start || null, end || null);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // 同時給 ascii fallback 檔名跟 UTF-8 檔名（RFC 5987），新版瀏覽器會優先用 filename*，
    // 自訂分類是中文名稱時也能正常顯示，不會被截斷成 category_xxx
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(prettyFilename)}`
    );
    return res.status(200).send(bom + csv);
  } catch (err) {
    console.error(err);
    return res.status(500).send('export failed');
  }
}