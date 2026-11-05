import { validateEntry } from './core.js';

export function dueEntries(entries, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('当前时间无效');
  return entries.filter((entry) => !entry.mastered && (!entry.review || Date.parse(entry.review.dueAt) <= now))
    .sort((left, right) => (Date.parse(left.review?.dueAt ?? left.createdAt) - Date.parse(right.review?.dueAt ?? right.createdAt))
      || left.term.localeCompare(right.term));
}

export function gradeEntry(value, feedback, now = Date.now()) {
  const entry = validateEntry(value);
  if (!['known', 'fuzzy', 'again'].includes(feedback)) throw new Error('复习反馈无效');
  if (!Number.isFinite(now) || now < 0 || now > Date.parse('9999-01-01T00:00:00.000Z')) throw new Error('当前时间无效');
  if (entry.mastered) throw new Error('请先将已掌握词重新加入复习');
  if (entry.review && now < Date.parse(entry.review.dueAt)) throw new Error('词条尚未到期，请刷新复习列表或检查系统时间');
  const step = feedback === 'known' ? Math.min(6, entry.review?.feedback === 'known' ? entry.review.step + 1 : 0) : 0;
  const delay = feedback === 'again' ? 10 * 60 * 1000 : (feedback === 'fuzzy' ? 1 : [1, 3, 7, 14, 30, 90, 180][step]) * 86400000;
  return validateEntry({ ...entry, review: { count: (entry.review?.count ?? 0) + 1, step, feedback,
    lastAt: new Date(now).toISOString(), dueAt: new Date(now + delay).toISOString() } });
}
