import { getFirestore } from './firebaseAdmin';

// 8 個內建分類，名稱本身不能改（歷史資料都是用這些名稱存的），但可以停用
export const BUILTIN_CATEGORIES = ['飲食', '交通', '購物', '娛樂', '醫療', '居家', '固定支出', '其他'];

export const BUILTIN_EMOJI = {
  飲食: '🍜',
  交通: '🚗',
  購物: '🛍️',
  娛樂: '🎮',
  醫療: '🏥',
  居家: '🏠',
  固定支出: '📌',
  其他: '📦',
};

export const BUILTIN_COLOR_HEX = {
  飲食: '#f97066',
  交通: '#4f9cf9',
  購物: '#f9c846',
  娛樂: '#a78bfa',
  醫療: '#34d399',
  居家: '#fb923c',
  固定支出: '#5B7F76',
  其他: '#9ca3af',
};

// 只用在 CSV 檔名（避免中文檔名在部分瀏覽器/OS下亂碼），自訂分類沒有對照，export.js 會另外處理
export const BUILTIN_SLUG = {
  飲食: 'food',
  交通: 'transport',
  購物: 'shopping',
  娛樂: 'entertainment',
  醫療: 'medical',
  居家: 'home',
  固定支出: 'fixed',
  其他: 'other',
};

// 分類預算的預設比例，只涵蓋內建分類，總和固定 100%；自訂分類預設 0%，由使用者自己分配
export const DEFAULT_CATEGORY_ALLOCATION = {
  飲食: 25,
  居家: 20,
  固定支出: 15,
  交通: 10,
  購物: 10,
  娛樂: 10,
  醫療: 5,
  其他: 5,
};

// 自訂分類沒指定 emoji/顏色時，依新增順序輪流從這裡拿一個，避免每個自訂分類看起來都一樣
const FALLBACK_EMOJI_POOL = ['📁', '🔖', '🏷️', '📎', '🧩', '🔷', '🎯', '🌱', '🐾', '🎁', '🧸', '🛠️'];
const FALLBACK_COLOR_POOL = ['#7c9cbf', '#c97ba1', '#8fb996', '#d4a05a', '#9a8fc9', '#5cadad', '#c97b7b', '#7bab5e'];

// LINE Quick Reply 上限 13 顆，扣掉「取消」剩 12 顆，所以啟用中的分類（內建+自訂）最多只能有 12 個
export const MAX_ACTIVE_CATEGORIES = 12;
// 自訂分類名稱長度上限：emoji + 名稱 + 後綴（例如「明細」兩字）要塞進 20 字的 Quick Reply label
export const MAX_CATEGORY_NAME_LENGTH = 6;

function userDoc(userId) {
  return getFirestore().collection('expenses').doc(userId);
}

export async function getCategoryConfig(userId) {
  const doc = await userDoc(userId).get();
  const cfg = (doc.exists && doc.data().categoryConfig) || {};
  return { disabled: cfg.disabled || [], custom: cfg.custom || [] };
}

async function saveCategoryConfig(userId, cfg) {
  await userDoc(userId).set(
    { categoryConfig: { disabled: cfg.disabled, custom: cfg.custom } },
    { merge: true }
  );
}

// 完整分類定義（內建 + 自訂，含 emoji/顏色/是否啟用），依序：內建固定順序在前，自訂依新增順序接在後面
export function buildCategoryDefs(cfg) {
  const builtins = BUILTIN_CATEGORIES.map((name) => ({
    name,
    emoji: BUILTIN_EMOJI[name],
    color: BUILTIN_COLOR_HEX[name],
    slug: BUILTIN_SLUG[name],
    enabled: !cfg.disabled.includes(name),
    isCustom: false,
  }));
  const customs = cfg.custom.map((c, i) => ({
    name: c.name,
    emoji: c.emoji || FALLBACK_EMOJI_POOL[i % FALLBACK_EMOJI_POOL.length],
    color: FALLBACK_COLOR_POOL[i % FALLBACK_COLOR_POOL.length],
    slug: null,
    enabled: !cfg.disabled.includes(c.name),
    isCustom: true,
  }));
  return [...builtins, ...customs];
}

export function allCategoryNames(cfg) {
  return [...BUILTIN_CATEGORIES, ...cfg.custom.map((c) => c.name)];
}

export function activeCategoryNames(cfg) {
  return allCategoryNames(cfg).filter((name) => !cfg.disabled.includes(name));
}

// 記帳/預算分配等「只能挑目前可用分類」的情境用這個
export async function getActiveCategoryDefs(userId) {
  const cfg = await getCategoryConfig(userId);
  return buildCategoryDefs(cfg).filter((c) => c.enabled);
}

// 查詢/分類設定總覽等「連已停用的也要看得到」的情境用這個
export async function getAllCategoryDefs(userId) {
  const cfg = await getCategoryConfig(userId);
  return buildCategoryDefs(cfg);
}

const MAX_EMOJI_INPUT_LENGTH = 16; // 一般emoji 1-2字，複合emoji（家庭、膚色、旗幟等ZWJ組合）可能到10字左右，留寬一點的緩衝
const emojiSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// 判斷輸入是不是「剛好一個emoji」：用 Intl.Segmenter 切字素叢集（複合emoji例如🏃‍♂️、👨‍👩‍👧‍👦
// 底層是好幾個 Unicode 碼位組成，但視覺跟語意上是一個emoji，要算1個叢集才對，不能只看字串長度），
// 必須剛好切出1個叢集，而且這個叢集要含有實際的emoji圖形字元，不能是一般文字
function isLikelyEmojiInput(str) {
  const trimmed = (str || '').trim();
  if (!trimmed || trimmed.length > MAX_EMOJI_INPUT_LENGTH) return false;
  if (/[a-zA-Z0-9\u4e00-\u9fff]/.test(trimmed)) return false;
  const segments = Array.from(emojiSegmenter.segment(trimmed));
  if (segments.length !== 1) return false;
  return /\p{Extended_Pictographic}/u.test(trimmed);
}

export async function addCategory(userId, name, emoji) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { invalid: true };
  if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) return { tooLong: true, maxLength: MAX_CATEGORY_NAME_LENGTH };
  if (emoji && !isLikelyEmojiInput(emoji)) return { invalidEmoji: true };

  const cfg = await getCategoryConfig(userId);
  if (allCategoryNames(cfg).includes(trimmed)) return { duplicate: true };
  if (activeCategoryNames(cfg).length >= MAX_ACTIVE_CATEGORIES) return { tooMany: true, max: MAX_ACTIVE_CATEGORIES };

  const newCfg = { ...cfg, custom: [...cfg.custom, { name: trimmed, emoji: emoji || null }] };
  await saveCategoryConfig(userId, newCfg);
  return { ok: true, defs: buildCategoryDefs(newCfg), added: trimmed };
}

// enabled=false 停用、true 啟用；停用時不動預算比例（呼叫端要自己決定要不要把 % 收回分給別人）
export async function setCategoryEnabled(userId, name, enabled) {
  const cfg = await getCategoryConfig(userId);
  if (!allCategoryNames(cfg).includes(name)) return { notFound: true };

  const isDisabled = cfg.disabled.includes(name);
  if (enabled && !isDisabled) return { alreadyEnabled: true };
  if (!enabled && isDisabled) return { alreadyDisabled: true };
  if (!enabled && activeCategoryNames(cfg).length <= 1) return { lastOne: true };

  const disabled = enabled ? cfg.disabled.filter((n) => n !== name) : [...cfg.disabled, name];
  const newCfg = { ...cfg, disabled };
  await saveCategoryConfig(userId, newCfg);
  return { ok: true, defs: buildCategoryDefs(newCfg) };
}

// 修改自訂分類的 emoji；內建分類的 emoji 是固定表，暫不支援修改（維持圖示一致性）
export async function setCategoryEmoji(userId, name, emoji) {
  const cfg = await getCategoryConfig(userId);
  if (!allCategoryNames(cfg).includes(name)) return { notFound: true };
  if (BUILTIN_CATEGORIES.includes(name)) return { builtin: true };
  if (!isLikelyEmojiInput(emoji)) return { invalidEmoji: true };

  const custom = cfg.custom.map((c) => (c.name === name ? { ...c, emoji } : c));
  const newCfg = { ...cfg, custom };
  await saveCategoryConfig(userId, newCfg);
  return { ok: true, defs: buildCategoryDefs(newCfg) };
}

// 修改自訂分類的名稱；只更新 categoryConfig 本身（custom 清單、disabled 清單裡的名字）。
// 呼叫端（parseExpense.js）還要負責把既有記錄的 category 欄位、預算比例的 key 一併migrate過去
export async function renameCategoryConfig(userId, oldName, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) return { invalid: true };
  if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) return { tooLong: true, maxLength: MAX_CATEGORY_NAME_LENGTH };

  const cfg = await getCategoryConfig(userId);
  const isCustom = cfg.custom.some((c) => c.name === oldName);
  if (!isCustom) return { notFound: true };
  if (trimmed === oldName) return { unchanged: true };
  if (allCategoryNames(cfg).includes(trimmed)) return { duplicate: true };

  const custom = cfg.custom.map((c) => (c.name === oldName ? { ...c, name: trimmed } : c));
  const disabled = cfg.disabled.map((n) => (n === oldName ? trimmed : n));
  const newCfg = { disabled, custom };
  await saveCategoryConfig(userId, newCfg);
  return { ok: true, defs: buildCategoryDefs(newCfg) };
}

export function findCategoryDef(defs, name) {
  return defs.find((c) => c.name === name) || null;
}