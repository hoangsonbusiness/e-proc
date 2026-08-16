export async function loadPagedBatches(db, options) {
    const totalsResult = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM batches) AS total_batches,
      (SELECT COUNT(*) FROM students) AS total_students
  `);
    const total = Number(totalsResult.rows[0]?.total_batches) || 0;
    const totalStudents = Number(totalsResult.rows[0]?.total_students) || 0;
    const totalPages = Math.max(1, Math.ceil(total / options.pageSize));
    const page = Math.min(Math.max(1, options.page), totalPages);
    const offset = (page - 1) * options.pageSize;
    const blueprintColumn = options.includeBlueprint ? ', b.blueprint' : '';
    const itemsResult = await db.query(`
    SELECT
      b.id, b.name, b.start_time, b.end_time, b.duration,
      b.record_enabled, b.record_mode, b.exam_type, b.created_by,
      b.ai_grading_status, b.created_at${blueprintColumn},
      COUNT(s.id) AS students_count
    FROM batches b
    LEFT JOIN students s ON s.batch_id = b.id
    GROUP BY b.id
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ? OFFSET ?
  `, [options.pageSize, offset]);
    const items = itemsResult.rows.map((batch) => ({
        ...batch,
        students_count: Number(batch.students_count) || 0,
        ...(options.includeBlueprint
            ? { blueprint: batch.blueprint && typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : batch.blueprint || null }
            : {}),
    }));
    return { items, total, totalStudents, page, pageSize: options.pageSize, totalPages };
}
export async function loadPagedStudents(db, batchId, options) {
    const batchResult = await db.query(`
    SELECT id, name, duration, start_time, end_time, exam_type, record_mode
    FROM batches WHERE id = ?
  `, [batchId]);
    if (batchResult.rows.length === 0)
        return null;
    const conditions = ['batch_id = ?'];
    const params = [batchId];
    if (options.search) {
        conditions.push('LOWER(email) LIKE ?');
        params.push(`%${options.search.toLowerCase()}%`);
    }
    const whereSql = conditions.join(' AND ');
    const countResult = await db.query(`SELECT COUNT(*) AS total FROM students WHERE ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / options.pageSize));
    const page = Math.min(Math.max(1, options.page), totalPages);
    const offset = (page - 1) * options.pageSize;
    const itemsResult = await db.query(`
    SELECT id, email, access_code, status
    FROM students
    WHERE ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `, [...params, options.pageSize, offset]);
    return {
        batch: batchResult.rows[0],
        items: itemsResult.rows,
        total,
        page,
        pageSize: options.pageSize,
        totalPages,
    };
}
