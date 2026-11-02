const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate, authenticateBearer } = require('../middleware/auth');
const dataStore = require('../data-store');
const { canAccessVideoResource, isSameUserId } = require('../services/video-access-policy');
const { publicationError, VIDEO_REVIEW_LOCK_MESSAGE, VIDEO_PROCESSING_LOCK_MESSAGE } = require('../services/video-publication-policy');

function normalizeTagIds(values) {
  return Array.from(new Set(values.map(value => {
    const number = Number(String(value ?? '').trim().replace(/^u:/, ''));
    return Number.isInteger(number) && number > 0 ? number : null;
  }).filter(value => value !== null)));
}

async function setVideoTags(videoId, user, body) {
  const wantsSetGlobals = Object.hasOwn(body, 'global_tag_ids');
  if ((wantsSetGlobals && !Array.isArray(body.global_tag_ids))
      || (Object.hasOwn(body, 'user_tag_ids') && !Array.isArray(body.user_tag_ids))) {
    throw publicationError(400, '标签ID必须为数组');
  }
  const globalIds = normalizeTagIds(body.global_tag_ids || []);
  const userIds = normalizeTagIds(body.user_tag_ids || []);
  const client = await dataStore.pool.connect();
  try {
    await client.query('BEGIN');
    // Match submit/review/edit lock order, then recheck the current publication state.
    const { rows: videos } = await client.query('SELECT * FROM video_resources WHERE id = $1 FOR UPDATE', [videoId]);
    const video = videos[0];
    if (!video) throw publicationError(404, '视频不存在');
    if (!canAccessVideoResource(video, user)) throw publicationError(403, 'FORBIDDEN');
    const allowGlobal = Boolean(user.is_admin) || isSameUserId(video.uploader_id, user.id);
    const convertedToPersonal = [];

    if (userIds.length) {
      const { rows } = await client.query('SELECT id FROM user_tags WHERE user_id = $1 AND id = ANY($2::bigint[])', [user.id, userIds]);
      if (rows.length !== userIds.length) throw publicationError(403, '包含无权限的个人标签');
    }
    if (globalIds.length) {
      const { rows } = await client.query('SELECT id FROM tags WHERE scope = $1 AND id = ANY($2::bigint[])', ['global', globalIds]);
      if (rows.length !== globalIds.length) throw publicationError(400, '包含不存在的全局标签');
    }

    if (allowGlobal && wantsSetGlobals) {
      const { rows: current } = await client.query('SELECT tag_id FROM video_tags WHERE video_id = $1', [videoId]);
      const currentIds = new Set(current.map(row => String(row.tag_id)));
      const changed = currentIds.size !== globalIds.length || globalIds.some(id => !currentIds.has(String(id)));
      // An unchanged global selection may accompany an independent personal edit.
      if (changed) {
        if (video.status === 'processing') throw publicationError(409, VIDEO_PROCESSING_LOCK_MESSAGE);
        if (!user.is_admin) {
          const { rows: pending } = await client.query("SELECT id FROM video_share_requests WHERE video_resource_id = $1 AND status = 'pending' LIMIT 1", [videoId]);
          if (video.is_public === true || pending.length) throw publicationError(409, VIDEO_REVIEW_LOCK_MESSAGE);
        }
        await client.query('DELETE FROM video_tags WHERE video_id = $1', [videoId]);
        for (const id of globalIds) {
          await client.query('INSERT INTO video_tags(video_id, tag_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [videoId, id, user.id]);
        }
      }
    } else if (!allowGlobal && globalIds.length) {
      const { rows: metadata } = await client.query('SELECT id, name, icon, color FROM tags WHERE id = ANY($1::bigint[])', [globalIds]);
      for (const tag of metadata) {
        const { rows } = await client.query(
          `INSERT INTO user_tags (user_id, name, icon, color) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, name) DO UPDATE SET icon = EXCLUDED.icon, color = EXCLUDED.color, updated_at = NOW()
           RETURNING id`, [user.id, tag.name, tag.icon, tag.color]);
        if (rows[0]) convertedToPersonal.push(Number(rows[0].id));
      }
    }

    await client.query('DELETE FROM video_user_tags WHERE video_id = $1 AND user_id = $2', [videoId, user.id]);
    for (const id of new Set([...userIds, ...convertedToPersonal])) {
      await client.query('INSERT INTO video_user_tags(video_id, user_tag_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [videoId, id, user.id]);
    }
    await client.query('COMMIT');
    return convertedToPersonal;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function requireAdmin(req) {
  const u = await authenticateBearer(req);
  if (!u?.is_admin) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  return u;
}

async function registerTagRoutes(pathname, req, res, url) {
  // POST /videos/tags/batch - 批量获取视频标签映射（全局 + 当前用户个人标签）
  // 目的：避免前端逐个请求 /videos/:id/tags 导致首屏慢
  if (pathname === '/videos/tags/batch' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const videoIds = Array.isArray(body?.video_ids) ? body.video_ids : [];

      const normalizeVideoId = (val) => {
        const num = Number(String(val || '').trim());
        if (!Number.isInteger(num) || num <= 0) return null;
        return num;
      };
      let safeVideoIds = Array.from(new Set(videoIds.map(normalizeVideoId).filter(v => v !== null)));
      if (safeVideoIds.length === 0) {
        return sendJson(res, 200, { success: true, items: [] });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      const { rows: videos } = await dataStore.pool.query('SELECT id, uploader_id, is_public, is_vip_only FROM video_resources WHERE id = ANY($1::bigint[])', [safeVideoIds]);
      const accessible = new Set(videos.filter(video => canAccessVideoResource(video, user)).map(video => String(video.id)));
      safeVideoIds = safeVideoIds.filter(id => accessible.has(String(id)));
      if (!safeVideoIds.length) return sendJson(res, 200, { success: true, items: [] });

      const { rows: globalRows } = await dataStore.pool.query(
        `SELECT video_id, array_agg(tag_id ORDER BY tag_id) AS global_tag_ids
         FROM video_tags
         WHERE video_id = ANY($1::bigint[])
         GROUP BY video_id`,
        [safeVideoIds]
      );
      const { rows: personalRows } = await dataStore.pool.query(
        `SELECT video_id, array_agg(user_tag_id ORDER BY user_tag_id) AS user_tag_ids
         FROM video_user_tags
         WHERE user_id = $2 AND video_id = ANY($1::bigint[])
         GROUP BY video_id`,
        [safeVideoIds, user.id]
      );

      const globalMap = new Map(globalRows.map(r => [Number(r.video_id), r.global_tag_ids || []]));
      const userMap = new Map(personalRows.map(r => [Number(r.video_id), r.user_tag_ids || []]));
      const items = safeVideoIds.map((vid) => ({
        video_id: vid,
        global_tag_ids: globalMap.get(vid) || [],
        user_tag_ids: userMap.get(vid) || []
      }));

      return sendJson(res, 200, { success: true, items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /tags - 全局标签 + 当前用户个人标签 + 偏好
  if (pathname === '/tags' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const userId = user.id;

      const { rows: globalTags } = await dataStore.pool.query(
        'SELECT id, name, icon, color, scope FROM tags WHERE scope = $1 ORDER BY id',
        ['global']
      );
      const { rows: userTags } = await dataStore.pool.query(
        'SELECT id, name, icon, color FROM user_tags WHERE user_id = $1 ORDER BY id',
        [userId]
      );
      const { rows: prefs } = await dataStore.pool.query(
        'SELECT tag_id, hidden, pinned, alias FROM user_tag_preferences WHERE user_id = $1',
        [userId]
      );

      console.log('[Tags] GET /tags success', {
        user_id: userId,
        global_count: globalTags.length,
        user_count: userTags.length,
        pref_count: prefs.length
      });

      return sendJson(res, 200, {
        success: true,
        global_tags: globalTags,
        user_tags: userTags.map(t => ({ ...t, scope: 'user' })),
        preferences: prefs
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      const authHeader = req.headers?.authorization ? 'present' : 'missing';
      console.error('[Tags] GET /tags failed', {
        status,
        message: err.message,
        stack: err.stack,
        auth_header: authHeader,
        ip: req.socket?.remoteAddress
      });
      return sendError(res, status, err.message);
    }
  }

  // GET /tags/cleanup-duplicates - 检查并清理重复标签（管理员）
  if (pathname === '/tags/cleanup-duplicates' && req.method === 'GET') {
    try {
      await requireAdmin(req);

      // 查找重复的全局标签（相同名称）
      const { rows: duplicates } = await dataStore.pool.query(`
        SELECT name, array_agg(id ORDER BY id) as ids, count(*) as cnt
        FROM tags
        WHERE scope = 'global'
        GROUP BY name
        HAVING count(*) > 1
        ORDER BY name
      `);

      if (duplicates.length === 0) {
        return sendJson(res, 200, { success: true, message: '没有发现重复标签', duplicates: [] });
      }

      console.log('[Tags] Found duplicate tags:', duplicates);

      // 自动清理：保留最小ID，删除其他
      let cleaned = 0;
      for (const dup of duplicates) {
        const idsToDelete = dup.ids.slice(1); // 保留第一个（最小ID），删除其他
        if (idsToDelete.length > 0) {
          // 更新 video_tags 引用到保留的ID
          const keepId = dup.ids[0];
          await dataStore.pool.query(
            'UPDATE video_tags SET tag_id = $1 WHERE tag_id = ANY($2::bigint[])',
            [keepId, idsToDelete]
          );
          // 删除重复的标签
          const { rowCount } = await dataStore.pool.query(
            'DELETE FROM tags WHERE id = ANY($1::bigint[])',
            [idsToDelete]
          );
          cleaned += rowCount;
          console.log(`[Tags] Cleaned duplicate tag "${dup.name}": kept id=${keepId}, deleted ids=${idsToDelete.join(',')}`);
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: `清理了 ${cleaned} 个重复标签`,
        duplicates: duplicates.map(d => ({ name: d.name, ids: d.ids, kept: d.ids[0], deleted: d.ids.slice(1) }))
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      console.error('[Tags] cleanup-duplicates failed', { status, message: err.message, stack: err.stack });
      return sendError(res, status, err.message);
    }
  }

  // POST /tags - 创建全局标签（管理员）
  if (pathname === '/tags' && req.method === 'POST') {
    try {
      await requireAdmin(req);
      const { name, icon = '🏷️', color = '#64748b' } = await parseBody(req);
      if (!name) return sendError(res, 400, '缺少 name');
      const trimmedName = name.trim();
      console.log('[Tags] POST /tags create request', { name: trimmedName, icon, color });

      // 检查是否已存在同名标签
      const { rows: existing } = await dataStore.pool.query(
        'SELECT id FROM tags WHERE scope = $1 AND LOWER(TRIM(name)) = LOWER($2)',
        ['global', trimmedName]
      );
      if (existing.length > 0) {
        return sendError(res, 409, `标签 "${trimmedName}" 已存在`);
      }

      const { rows } = await dataStore.pool.query(
        `INSERT INTO tags(name, icon, color, scope)
         VALUES ($1, $2, $3, 'global')
         RETURNING id, name, icon, color, scope`,
        [trimmedName, icon, color]
      );
      console.log('[Tags] POST /tags created', rows[0]);
      return sendJson(res, 200, { success: true, tag: rows[0] });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      console.error('[Tags] POST /tags failed', { status, message: err.message, stack: err.stack });
      return sendError(res, status, err.message);
    }
  }

  // PATCH /tags/:id - 更新全局标签（管理员）
  if (pathname.startsWith('/tags/') && req.method === 'PATCH') {
    try {
      await requireAdmin(req);
      const parts = pathname.split('/');
      const tagId = Number(parts[2]);
      if (!tagId) return sendError(res, 400, '缺少标签ID');
      const { name, icon, color } = await parseBody(req);
      const { rowCount, rows } = await dataStore.pool.query(
        `UPDATE tags SET
           name = COALESCE($1, name),
           icon = COALESCE($2, icon),
           color = COALESCE($3, color),
           updated_at = NOW()
         WHERE id = $4 AND scope = 'global'
         RETURNING id, name, icon, color, scope`,
        [name, icon, color, tagId]
      );
      if (rowCount === 0) return sendError(res, 404, '标签不存在');
      return sendJson(res, 200, { success: true, tag: rows[0] });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // DELETE /tags/:id - 删除全局标签（管理员）
  if (pathname.startsWith('/tags/') && req.method === 'DELETE') {
    try {
      await requireAdmin(req);
      const parts = pathname.split('/');
      const tagId = Number(parts[2]);
      if (!tagId) return sendError(res, 400, '缺少标签ID');
      await dataStore.pool.query('DELETE FROM video_tags WHERE tag_id = $1', [tagId]);
      const { rowCount } = await dataStore.pool.query('DELETE FROM tags WHERE id = $1 AND scope = \'global\'', [tagId]);
      if (rowCount === 0) return sendError(res, 404, '标签不存在');
      return sendJson(res, 200, { success: true, deleted: rowCount });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /user-tags - 创建个人标签
  if (pathname === '/user-tags' && req.method === 'POST') {
    try {
      const user = await authenticateBearer(req);
      const { name, icon = '🏷️', color = '#64748b' } = await parseBody(req);
      if (!name) return sendError(res, 400, '缺少 name');
      const { rows } = await dataStore.pool.query(
        `INSERT INTO user_tags(user_id, name, icon, color)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING id, name, icon, color`,
        [user.id, name.trim(), icon, color]
      );
      if (!rows.length) return sendError(res, 409, '标签已存在');
      return sendJson(res, 200, { success: true, tag: rows[0] });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // PATCH /user-tags/:id - 更新个人标签
  if (pathname.startsWith('/user-tags/') && req.method === 'PATCH') {
    try {
      const user = await authenticateBearer(req);
      const tagId = Number(pathname.split('/')[2]);
      if (!tagId) return sendError(res, 400, '缺少标签ID');
      const { name, icon, color } = await parseBody(req);
      const { rowCount, rows } = await dataStore.pool.query(
        `UPDATE user_tags SET
           name = COALESCE($1, name),
           icon = COALESCE($2, icon),
           color = COALESCE($3, color),
           updated_at = NOW()
         WHERE id = $4 AND user_id = $5
         RETURNING id, name, icon, color`,
        [name, icon, color, tagId, user.id]
      );
      if (rowCount === 0) return sendError(res, 404, '标签不存在或无权限');
      return sendJson(res, 200, { success: true, tag: rows[0] });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // DELETE /user-tags/:id - 删除个人标签
  if (pathname.startsWith('/user-tags/') && req.method === 'DELETE') {
    try {
      const user = await authenticateBearer(req);
      const tagId = Number(pathname.split('/')[2]);
      if (!tagId) return sendError(res, 400, '缺少标签ID');
      await dataStore.pool.query('DELETE FROM video_user_tags WHERE user_tag_id = $1 AND user_id = $2', [tagId, user.id]);
      const { rowCount } = await dataStore.pool.query(
        'DELETE FROM user_tags WHERE id = $1 AND user_id = $2',
        [tagId, user.id]
      );
      if (rowCount === 0) return sendError(res, 404, '标签不存在或无权限');
      return sendJson(res, 200, { success: true, deleted: rowCount });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /tag-preferences - 设置全局标签偏好
  if (pathname === '/tag-preferences' && req.method === 'POST') {
    try {
      const user = await authenticateBearer(req);
      const body = await parseBody(req);
      const prefs = Array.isArray(body.preferences) ? body.preferences : [];
      for (const p of prefs) {
        if (!p.tag_id) continue;
        await dataStore.pool.query(
          `INSERT INTO user_tag_preferences(user_id, tag_id, hidden, pinned, alias, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (user_id, tag_id) DO UPDATE SET
             hidden = EXCLUDED.hidden,
             pinned = EXCLUDED.pinned,
             alias = EXCLUDED.alias,
             updated_at = NOW()`,
          [user.id, p.tag_id, !!p.hidden, !!p.pinned, p.alias || null]
        );
      }
      return sendJson(res, 200, { success: true });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /videos/:id/tags - 设置视频标签（全局+个人）
  if (pathname.startsWith('/videos/') && pathname.endsWith('/tags') && req.method === 'POST') {
    try {
      const user = await authenticateBearer(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) return sendError(res, 400, '缺少视频ID');
      const body = await parseBody(req);
      const convertedToPersonal = await setVideoTags(videoId, user, body);
      return sendJson(res, 200, { success: true, converted_to_user_tags: convertedToPersonal });
    } catch (err) {
      console.error('[Admin Tags] Set tags failed', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /videos/:id/tags - 获取视频的标签（全局 + 当前用户的个人标签）
  if (pathname.startsWith('/videos/') && pathname.endsWith('/tags') && req.method === 'GET') {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) return sendError(res, 400, '缺少视频ID');
      const video = await dataStore.getVideoResourceById(videoId);
      if (!video) return sendError(res, 404, '视频不存在');
      if (!canAccessVideoResource(video, user)) return sendError(res, 403, 'FORBIDDEN');

      const { rows: globalRows } = await dataStore.pool.query(
        'SELECT tag_id FROM video_tags WHERE video_id = $1',
        [videoId]
      );
      const { rows: personalRows } = await dataStore.pool.query(
        'SELECT user_tag_id FROM video_user_tags WHERE video_id = $1 AND user_id = $2',
        [videoId, user.id]
      );

      const payload = {
        success: true,
        global_tag_ids: globalRows.map(r => r.tag_id),
        user_tag_ids: personalRows.map(r => r.user_tag_id)
      };
      console.log('[Admin Tags] GET video tags', { user_id: user.id, video_id: videoId, payload });
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  return false;
}

module.exports = {
  registerTagRoutes
};
