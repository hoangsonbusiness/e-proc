import type { DbExecutor } from '../db/postgres.js';

export type QuestionCategory = 'all' | 'essay' | 'quiz';

export async function loadPagedQuestions(
  db: DbExecutor,
  options: { page: number; pageSize: number; moduleName: string; category: QuestionCategory },
): Promise<{ items: any[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  if (options.moduleName) {
    conditions.push('module = ?');
    params.push(options.moduleName);
  }
  if (options.category === 'quiz') {
    conditions.push("type IN ('SingleChoice', 'MultipleChoice')");
  } else if (options.category === 'essay') {
    conditions.push("type NOT IN ('SingleChoice', 'MultipleChoice')");
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countResult = await db.query(`SELECT COUNT(*) AS total FROM question_bank ${whereSql}`, params);
  const total = Number(countResult.rows[0]?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const offset = (page - 1) * options.pageSize;
  const itemsResult = await db.query(`
    SELECT id, type, level, module, question_sample, uploaded_by
    FROM question_bank
    ${whereSql}
    ORDER BY module, level, id
    LIMIT ? OFFSET ?
  `, [...params, options.pageSize, offset]);

  return { items: itemsResult.rows, total, page, pageSize: options.pageSize, totalPages };
}

export async function loadQuestionCatalogSummary(db: DbExecutor): Promise<any> {
  const result = await db.query(`
    SELECT module, type, level, COUNT(*) AS count
    FROM question_bank
    GROUP BY module, type, level
    ORDER BY module, type, level
  `);
  const modules = new Set<string>();
  const moduleStats = new Map<string, { module: string; easy: number; medium: number; hard: number }>();
  const typeStats = new Map<string, { type: string; easy: number; medium: number; hard: number }>();
  const moduleTypeStats = new Map<string, { module: string; type: string; easy: number; medium: number; hard: number }>();

  for (const row of result.rows) {
    const moduleName = String(row.module);
    const type = String(row.type);
    const level = String(row.level).toLowerCase();
    const count = Number(row.count) || 0;
    if (!['easy', 'medium', 'hard'].includes(level)) continue;
    modules.add(moduleName);

    const moduleEntry = moduleStats.get(moduleName) || { module: moduleName, easy: 0, medium: 0, hard: 0 };
    moduleEntry[level as 'easy' | 'medium' | 'hard'] += count;
    moduleStats.set(moduleName, moduleEntry);

    const typeEntry = typeStats.get(type) || { type, easy: 0, medium: 0, hard: 0 };
    typeEntry[level as 'easy' | 'medium' | 'hard'] += count;
    typeStats.set(type, typeEntry);

    const key = `${moduleName}\u0000${type}`;
    const moduleTypeEntry = moduleTypeStats.get(key) || { module: moduleName, type, easy: 0, medium: 0, hard: 0 };
    moduleTypeEntry[level as 'easy' | 'medium' | 'hard'] += count;
    moduleTypeStats.set(key, moduleTypeEntry);
  }

  return {
    modules: [...modules].sort((a, b) => a.localeCompare(b)),
    moduleStats: [...moduleStats.values()],
    typeStats: [...typeStats.values()],
    moduleTypeStats: [...moduleTypeStats.values()],
  };
}

