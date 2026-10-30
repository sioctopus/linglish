const { pool, dbUnavailable } = require('./core');

// Helper: run ALTER TABLE safely (log warning on failure, don't throw)
async function safeAlter(sql, context = '') {
  try {
    await pool.query(sql);
  } catch (err) {
    // Log but don't throw - ALTER failures shouldn't break the whole app
    console.warn(`[Schema] ALTER TABLE warning${context ? ' (' + context + ')' : ''}: ${err.message}`);
  }
}

async function ensureAuxTables() {
  if (dbUnavailable()) return;
  await safeAlter(`
    ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS pdf_path TEXT
  `, 'articles.pdf_path');
  // Users: add admin flag and last login IP for auditability
  await safeAlter(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE
  `, 'users.is_admin');
  await safeAlter(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_ip TEXT
  `, 'users.last_login_ip');
  await safeAlter(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE
  `, 'users.phone');
  await safeAlter(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMP
  `, 'users.email_verification');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
    ON users (email_verification_token)
    WHERE email_verification_token IS NOT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      requester_ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash
    ON password_resets (token_hash)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_resets_user_created
    ON password_resets (user_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_resets_expiry
    ON password_resets (expires_at)
    WHERE used_at IS NULL
  `);
  await safeAlter(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ls_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS ls_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS ls_variant_id TEXT,
    ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS subscription_end_date TIMESTAMP
  `, 'users.subscription_columns');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_ls_customer_id
    ON users (ls_customer_id)
    WHERE ls_customer_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_ls_subscription_id
    ON users (ls_subscription_id)
    WHERE ls_subscription_id IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      native_language VARCHAR(10) DEFAULT 'zh-CN',
      target_language VARCHAR(10) DEFAULT 'en',
      daily_goal INTEGER DEFAULT 15,
      interests TEXT[],
      theme VARCHAR(20) DEFAULT 'light',
      current_vocabulary_level VARCHAR(20) DEFAULT 'beginner',
      vocabulary_level_updated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    )
  `);
  await safeAlter(`
    ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS daily_goal INTEGER DEFAULT 15,
    ADD COLUMN IF NOT EXISTS interests TEXT[],
    ADD COLUMN IF NOT EXISTS current_vocabulary_level VARCHAR(20) DEFAULT 'beginner',
    ADD COLUMN IF NOT EXISTS vocabulary_level_updated_at TIMESTAMP
  `, 'user_profiles.onboarding_fields');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ls_payment_id TEXT NOT NULL UNIQUE,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await safeAlter(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS ls_payment_id TEXT
  `, 'payments.ls_payment_id');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_user_id
    ON payments (user_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ls_payment_id_unique
    ON payments (ls_payment_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_ls_payment_id
    ON payments (ls_payment_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_status_created
    ON payments (status, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_events (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'lemonsqueezy',
      event_key TEXT NOT NULL UNIQUE,
      event_name TEXT NOT NULL,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      ls_subscription_id TEXT,
      ls_customer_id TEXT,
      ls_order_id TEXT,
      ls_variant_id TEXT,
      status TEXT,
      amount INTEGER,
      currency TEXT,
      processed_status TEXT NOT NULL DEFAULT 'received',
      error_message TEXT,
      payload JSONB NOT NULL,
      received_at TIMESTAMP NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_subscription_events_user_id
    ON subscription_events (user_id, received_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_subscription_events_event_name
    ON subscription_events (event_name, received_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_subscription_events_processed_status
    ON subscription_events (processed_status, received_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_subscription_events_ls_subscription_id
    ON subscription_events (ls_subscription_id)
    WHERE ls_subscription_id IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_leads (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      visitor_id TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      organization TEXT NOT NULL,
      role TEXT,
      team_size TEXT,
      use_case TEXT,
      source TEXT DEFAULT 'pricing',
      intent TEXT DEFAULT 'team',
      status TEXT NOT NULL DEFAULT 'new',
      notes TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await safeAlter(`
    ALTER TABLE team_leads
    ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS visitor_id TEXT,
    ADD COLUMN IF NOT EXISTS role TEXT,
    ADD COLUMN IF NOT EXISTS team_size TEXT,
    ADD COLUMN IF NOT EXISTS use_case TEXT,
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'pricing',
    ADD COLUMN IF NOT EXISTS intent TEXT DEFAULT 'team',
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new',
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS ip TEXT,
    ADD COLUMN IF NOT EXISTS user_agent TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  `, 'team_leads.columns');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_team_leads_created_at
    ON team_leads (created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_team_leads_status_created
    ON team_leads (status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_team_leads_email
    ON team_leads (lower(email))
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_resources (
      id SERIAL PRIMARY KEY,
      uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      video_path TEXT NOT NULL UNIQUE,
      thumbnail_path TEXT,
      original_filename TEXT,
      transcript TEXT,
      transcript_segments JSONB,
      language VARCHAR(16),
      duration_sec INTEGER,
      status VARCHAR(32) DEFAULT 'processing',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_status
    ON video_resources (status)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_resources_video_path
    ON video_resources (video_path)
  `);

  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS failure_reason TEXT
  `, 'video_resources.failure_reason');
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS thumbnail_path TEXT
  `, 'video_resources.thumbnail_path');

  // V9: Add comprehensive metadata fields
  // File information fields
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS file_size BIGINT,
    ADD COLUMN IF NOT EXISTS mime_type VARCHAR(64),
    ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64)
  `, 'video_resources.file_info');

  // Content classification and management fields
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS category VARCHAR(32),
    ADD COLUMN IF NOT EXISTS collection_name TEXT,
    ADD COLUMN IF NOT EXISTS difficulty_level VARCHAR(16),
    ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS practice_count INTEGER DEFAULT 0
  `, 'video_resources.classification');
  await safeAlter(`
    ALTER TABLE video_resources
    ALTER COLUMN is_public SET DEFAULT FALSE
  `, 'video_resources.is_public_default');
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_vip_only BOOLEAN DEFAULT FALSE
  `, 'video_resources.commerce_flags');

  // Learning-related fields
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS subtitle_language VARCHAR(16),
    ADD COLUMN IF NOT EXISTS has_subtitles BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS word_count INTEGER,
    ADD COLUMN IF NOT EXISTS unique_word_count INTEGER
  `, 'video_resources.learning');

  // Create indexes for new fields
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_file_hash
    ON video_resources (file_hash)
    WHERE file_hash IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_category
    ON video_resources (category)
    WHERE category IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_difficulty
    ON video_resources (difficulty_level)
    WHERE difficulty_level IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_public
    ON video_resources (is_public)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_tags
    ON video_resources USING gin (tags)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_view_count
    ON video_resources (view_count DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_is_featured
    ON video_resources (is_featured)
  `);

  // V10: Add roleplay and character information fields
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS characters JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS is_roleplay_enabled BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS default_user_character TEXT,
    ADD COLUMN IF NOT EXISTS total_segments INTEGER DEFAULT 0
  `, 'video_resources.roleplay');

  // Listing and saving videos both reference these columns. Without them the
  // catalog query throws and the practice page falls back to an empty folder.
  await safeAlter(`
    ALTER TABLE video_resources
    ADD COLUMN IF NOT EXISTS video_type VARCHAR(16) DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
    ADD COLUMN IF NOT EXISTS local_video_path TEXT,
    ADD COLUMN IF NOT EXISTS local_video_status VARCHAR(32) DEFAULT 'not_downloaded',
    ADD COLUMN IF NOT EXISTS manual_order INTEGER
  `, 'video_resources.youtube_and_order');

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_roleplay_enabled
    ON video_resources (is_roleplay_enabled)
    WHERE is_roleplay_enabled = TRUE
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_resources_characters
    ON video_resources USING gin (characters)
  `);

  // Tag system tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tags (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Seed baseline global tags (safe to run repeatedly)
  await pool.query(`
    INSERT INTO tags(name, icon, color, scope)
    SELECT v.name, v.icon, v.color, 'global'
    FROM (VALUES
      ('我的', '⭐', '#6366f1'),
      ('职场', '💼', '#8b5cf6'),
      ('购物', '🛒', '#ec4899'),
      ('生活', '🏠', '#14b8a6'),
      ('影视', '🎬', '#f59e0b'),
      ('儿童', '🧸', '#38bdf8'),
      ('亲子', '👨‍👩‍👧‍👦', '#22c55e'),
      ('动画', '🎨', '#f97316'),
      ('故事', '📖', '#0ea5e9'),
      ('校园', '🏫', '#10b981'),
      ('演讲', '🎤', '#ef4444'),
      ('课程', '📚', '#a855f7')
    ) AS v(name, icon, color)
    WHERE NOT EXISTS (
      SELECT 1 FROM tags t WHERE t.scope = 'global' AND t.name = v.name
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_tags (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_tags (
      video_id BIGINT NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
      tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (video_id, tag_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_user_tags (
      video_id BIGINT NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
      user_tag_id BIGINT NOT NULL REFERENCES user_tags(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (video_id, user_tag_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_tag_preferences (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      alias TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, tag_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_vocab_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lemma TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'encountered',
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days REAL NOT NULL DEFAULT 1,
      review_count INTEGER NOT NULL DEFAULT 0,
      exposures INTEGER NOT NULL DEFAULT 0,
      lookups INTEGER NOT NULL DEFAULT 0,
      pronounces INTEGER NOT NULL DEFAULT 0,
      reads INTEGER NOT NULL DEFAULT 0,
      difficulty TEXT NOT NULL DEFAULT 'normal',
      notes TEXT,
      translation TEXT,
      first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_review_at TIMESTAMP,
      next_review_at TIMESTAMP,
      first_seen_context TEXT,
      first_seen_article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
      first_seen_video_id INTEGER REFERENCES video_resources(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, lemma)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vocab_next_review
    ON user_vocab_items (user_id, next_review_at)
  `);

  // 为已存在的表添加translation字段
  await safeAlter(`
    ALTER TABLE user_vocab_items
    ADD COLUMN IF NOT EXISTS translation TEXT
  `, 'user_vocab_items.translation');

  // Add new counters if they don't exist (safe on repeat)
  await safeAlter(`
    ALTER TABLE user_vocab_items
    ADD COLUMN IF NOT EXISTS lookups INTEGER NOT NULL DEFAULT 0
  `, 'user_vocab_items.lookups');
  await safeAlter(`
    ALTER TABLE user_vocab_items
    ADD COLUMN IF NOT EXISTS pronounces INTEGER NOT NULL DEFAULT 0
  `, 'user_vocab_items.pronounces');
  await safeAlter(`
    ALTER TABLE user_vocab_items
    ADD COLUMN IF NOT EXISTS reads INTEGER NOT NULL DEFAULT 0
  `, 'user_vocab_items.reads');
  await safeAlter(`
    ALTER TABLE user_vocab_items
    ADD COLUMN IF NOT EXISTS lapses INTEGER NOT NULL DEFAULT 0
  `, 'user_vocab_items.lapses');
  await safeAlter(`
    ALTER TABLE user_vocab_items
    ADD COLUMN IF NOT EXISTS consecutive_fails INTEGER NOT NULL DEFAULT 0
  `, 'user_vocab_items.consecutive_fails');

  await safeAlter(`
    ALTER TABLE user_vocabulary
    ADD COLUMN IF NOT EXISTS first_seen_video_id INTEGER REFERENCES video_resources(id) ON DELETE SET NULL
  `, 'user_vocabulary.first_seen_video_id');

  await safeAlter(`
    ALTER TABLE user_vocabulary
    ADD COLUMN IF NOT EXISTS first_seen_article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL
  `, 'user_vocabulary.first_seen_article_id');

  await safeAlter(`
    ALTER TABLE user_vocabulary
    ADD COLUMN IF NOT EXISTS first_seen_context TEXT
  `, 'user_vocabulary.first_seen_context');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vocab_contexts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lemma TEXT NOT NULL,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE CASCADE,
      segment_index INTEGER,
      start_sec REAL,
      end_sec REAL,
      sentence TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vocab_contexts_lemma
    ON vocab_contexts (user_id, lemma)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vocab_reviews (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lemma TEXT NOT NULL,
      outcome TEXT NOT NULL,
      ease_factor REAL,
      interval_days REAL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_scene_quests (
      id SERIAL PRIMARY KEY,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      character_name TEXT NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      script_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      difficulty VARCHAR(16) DEFAULT 'normal',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scene_quests_video
    ON video_scene_quests (video_resource_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_rewards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      quest_id INTEGER REFERENCES video_scene_quests(id) ON DELETE SET NULL,
      reward_type VARCHAR(32) NOT NULL,
      amount INTEGER NOT NULL,
      metadata JSONB,
      earned_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_rewards_user
    ON user_rewards (user_id, earned_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roleplay_runs (
      id SERIAL PRIMARY KEY,
      quest_id INTEGER REFERENCES video_scene_quests(id) ON DELETE CASCADE,
      session_id BIGINT REFERENCES training_sessions(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      transcript TEXT,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      score INTEGER NOT NULL,
      grade VARCHAR(8) NOT NULL,
      reward_id INTEGER REFERENCES user_rewards(id) ON DELETE SET NULL,
      recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (quest_id, user_id, attempt_number)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_roleplay_runs_user
    ON roleplay_runs (user_id, quest_id, recorded_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_roleplay_scenarios (
      id TEXT PRIMARY KEY,
      title_zh TEXT NOT NULL,
      title_en TEXT NOT NULL,
      category TEXT NOT NULL,
      cefr_min TEXT NOT NULL,
      cefr_max TEXT NOT NULL,
      learner_role TEXT NOT NULL,
      assistant_role TEXT NOT NULL,
      opening_line TEXT NOT NULL,
      opening_translation_zh TEXT NOT NULL,
      goals JSONB NOT NULL DEFAULT '[]'::jsonb,
      target_phrases JSONB NOT NULL DEFAULT '[]'::jsonb,
      fallback_turns JSONB NOT NULL DEFAULT '{}'::jsonb,
      turn_limit INTEGER NOT NULL DEFAULT 4 CHECK (turn_limit BETWEEN 1 AND 8),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_roleplay_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scenario_id TEXT NOT NULL REFERENCES ai_roleplay_scenarios(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned','failed')),
      cefr_level TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
      turn_limit INTEGER NOT NULL CHECK (turn_limit BETWEEN 1 AND 8),
      mission_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      review_summary JSONB,
      source TEXT NOT NULL DEFAULT 'catalog',
      transport_mode TEXT NOT NULL DEFAULT 'asr_tts',
      model_used TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_roleplay_turns (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES ai_roleplay_sessions(id) ON DELETE CASCADE,
      turn_key UUID NOT NULL,
      turn_index INTEGER NOT NULL CHECK (turn_index BETWEEN 1 AND 8),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
      learner_text TEXT NOT NULL,
      assistant_text TEXT,
      assistant_translation_zh TEXT,
      evaluation JSONB,
      turn_result JSONB,
      pronunciation_summary JSONB,
      response_mode TEXT CHECK (response_mode IS NULL OR response_mode IN ('ai','fallback')),
      latency_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, turn_key),
      UNIQUE (session_id, turn_index)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_roleplay_scenarios_catalog
    ON ai_roleplay_scenarios(is_active, category, sort_order)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_roleplay_sessions_user_status
    ON ai_roleplay_sessions(user_id, status, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_roleplay_sessions_scenario
    ON ai_roleplay_sessions(scenario_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_roleplay_sessions_expires
    ON ai_roleplay_sessions(expires_at)
    WHERE expires_at IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_roleplay_turns_session_status
    ON ai_roleplay_turns(session_id, status, updated_at DESC)
  `);
  await safeAlter(`
    ALTER TABLE ai_roleplay_turns
    ADD COLUMN IF NOT EXISTS turn_result JSONB
  `, 'ai_roleplay_turns.turn_result');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_practice_recordings (
      id SERIAL PRIMARY KEY,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      speaker TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      audio_path TEXT NOT NULL,
      duration_sec REAL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (video_resource_id, user_id, speaker, segment_index)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_practice_recordings_user
    ON video_practice_recordings (user_id, video_resource_id)
  `);

  await safeAlter(`
    ALTER TABLE video_practice_recordings
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  `, 'video_practice_recordings.updated_at');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS practice_recording_shares (
      id BIGSERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE CASCADE,
      speaker TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP,
      last_accessed_at TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_practice_recording_shares_token
    ON practice_recording_shares (token)
  `);

  // Admin/supporting tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_login_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      login_at TIMESTAMP NOT NULL DEFAULT NOW(),
      logout_at TIMESTAMP,
      login_ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_login_sessions_user_time
    ON user_login_sessions (user_id, login_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_device_sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      provider VARCHAR(32) NOT NULL DEFAULT 'password',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      absolute_expires_at TIMESTAMP NOT NULL,
      sliding_expires_at TIMESTAMP NOT NULL,
      revoked_at TIMESTAMP,
      last_google_check_at TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_user
    ON auth_device_sessions (user_id, revoked_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      video_upload_limit INTEGER NOT NULL DEFAULT 3,
      video_upload_used INTEGER NOT NULL DEFAULT 0,
      resets_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_admin_actions (
      id BIGSERIAL PRIMARY KEY,
      admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(50) NOT NULL,
      details JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_share_requests (
      id BIGSERIAL PRIMARY KEY,
      requester_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE CASCADE,
      request_type VARCHAR(20) NOT NULL DEFAULT 'public',
      note TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      review_note TEXT,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (request_type IN ('public', 'featured')),
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_share_requests_status
    ON video_share_requests (status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_share_requests_video
    ON video_share_requests (video_resource_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_share_requests_pending_unique
    ON video_share_requests (requester_id, video_resource_id, request_type)
    WHERE status = 'pending'
  `);

  // Ensure analytics events table exists (if migrations not executed)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      event_time TIMESTAMP NOT NULL,
      event_name VARCHAR(100) NOT NULL,
      properties JSONB,
      source VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, event_time DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_name_time ON events(event_name, event_time DESC)`);

  // Ensure rolling monthly events partitions exist.
  // This prevents "no partition of relation 'events' found for row" errors
  // when a new month starts.
  const partitionStart = new Date(Date.UTC(2025, 10, 1)); // 2025-11-01
  const currentMonthStart = new Date();
  currentMonthStart.setUTCDate(1);
  currentMonthStart.setUTCHours(0, 0, 0, 0);
  const partitionEnd = new Date(Date.UTC(
    currentMonthStart.getUTCFullYear(),
    currentMonthStart.getUTCMonth() + 4,
    1,
  ));

  const formatPartitionDate = (date) => date.toISOString().slice(0, 10);
  const formatPartitionName = (date) => {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `events_${year}_${month}`;
  };

  for (let cursor = new Date(partitionStart); cursor < partitionEnd; cursor = new Date(Date.UTC(
    cursor.getUTCFullYear(),
    cursor.getUTCMonth() + 1,
    1,
  ))) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const partition = {
      name: formatPartitionName(cursor),
      start: formatPartitionDate(cursor),
      end: formatPartitionDate(next),
    };

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${partition.name} PARTITION OF events
        FOR VALUES FROM ('${partition.start}') TO ('${partition.end}')
      `);
    } catch (err) {
      // Ignore if partition already exists or events is not partitioned yet
      if (!err.message.includes('already exists') && !err.message.includes('not partitioned')) {
        console.error(`Failed to create partition ${partition.name}:`, err.message);
      }
    }
  }

  // Pronunciation assessment tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_pronunciation_assessments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE SET NULL,
      lemma TEXT,
      text TEXT NOT NULL,
      audio_path TEXT,
      overall REAL,
      accuracy REAL,
      fluency REAL,
      completeness REAL,
      words JSONB,
      phonemes JSONB,
      provider TEXT,
      coaching JSONB,
      analysis_version TEXT,
      duration_seconds REAL,
      speech_rate_wpm REAL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await safeAlter(`
    ALTER TABLE user_pronunciation_assessments
    ADD COLUMN IF NOT EXISTS video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE SET NULL
  `, 'user_pronunciation_assessments.video_resource_id');
  await safeAlter(`
    ALTER TABLE user_pronunciation_assessments
    ADD COLUMN IF NOT EXISTS coaching JSONB,
    ADD COLUMN IF NOT EXISTS analysis_version TEXT,
    ADD COLUMN IF NOT EXISTS duration_seconds REAL,
    ADD COLUMN IF NOT EXISTS speech_rate_wpm REAL
  `, 'user_pronunciation_assessments.coaching');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pa_user_time ON user_pronunciation_assessments(user_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pa_user_video_time
    ON user_pronunciation_assessments(user_id, video_resource_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_pronunciation_focus (
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      phoneme TEXT NOT NULL,
      issue_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, phoneme)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_pronunciation_skills (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      display_target TEXT NOT NULL,
      evidence_level TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      issue_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      success_streak INTEGER NOT NULL DEFAULT 0,
      ema_score REAL,
      confidence REAL,
      status TEXT NOT NULL DEFAULT 'focus',
      next_review_at TIMESTAMPTZ,
      last_assessment_id BIGINT REFERENCES user_pronunciation_assessments(id) ON DELETE SET NULL,
      video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE SET NULL,
      sample_text TEXT,
      last_issue_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, skill_type, target_key)
    )
  `);
  const pronunciationSkillTimestampColumns = [
    'next_review_at',
    'last_issue_at',
    'last_success_at',
    'created_at',
    'updated_at',
  ];
  const { rows: legacyPronunciationSkillTimestamps } = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'user_pronunciation_skills'
        AND column_name = ANY($1::text[])
        AND data_type = 'timestamp without time zone'`,
    [pronunciationSkillTimestampColumns],
  );
  const legacyTimestampColumns = new Set(legacyPronunciationSkillTimestamps.map((row) => row.column_name));
  for (const columnName of pronunciationSkillTimestampColumns) {
    if (!legacyTimestampColumns.has(columnName)) continue;
    await safeAlter(
      `ALTER TABLE user_pronunciation_skills
       ALTER COLUMN ${columnName} TYPE TIMESTAMPTZ
       USING ${columnName} AT TIME ZONE 'UTC'`,
      `user_pronunciation_skills.${columnName}.timestamptz`,
    );
  }
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pronunciation_skills_due
    ON user_pronunciation_skills(user_id, next_review_at, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pronunciation_skills_last_assessment
    ON user_pronunciation_skills(last_assessment_id)
    WHERE last_assessment_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pronunciation_skills_video_resource
    ON user_pronunciation_skills(video_resource_id)
    WHERE video_resource_id IS NOT NULL
  `);

  // Learning milestones
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_milestones (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      milestone_type TEXT NOT NULL,
      milestone_name TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 0,
      xp_reward INTEGER NOT NULL DEFAULT 0,
      celebrated BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, milestone_type)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_milestones_user
    ON user_milestones (user_id, created_at DESC)
  `);

  // Study groups
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      group_type TEXT NOT NULL DEFAULT 'public',
      max_members INTEGER NOT NULL DEFAULT 50,
      member_count INTEGER NOT NULL DEFAULT 0,
      learning_goal TEXT,
      target_language TEXT NOT NULL DEFAULT 'en',
      difficulty_level TEXT,
      total_study_minutes INTEGER NOT NULL DEFAULT 0,
      total_xp INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_group_members (
      id BIGSERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES study_groups(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      contribution_xp INTEGER NOT NULL DEFAULT 0,
      study_minutes INTEGER NOT NULL DEFAULT 0,
      joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (group_id, user_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_group_members_group
    ON study_group_members (group_id, contribution_xp DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_challenges (
      id BIGSERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES study_groups(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      challenge_type TEXT NOT NULL DEFAULT 'study_minutes',
      target_value INTEGER NOT NULL DEFAULT 0,
      current_value INTEGER NOT NULL DEFAULT 0,
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date DATE,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_challenge_participants (
      id BIGSERIAL PRIMARY KEY,
      challenge_id BIGINT REFERENCES group_challenges(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      progress INTEGER NOT NULL DEFAULT 0,
      joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (challenge_id, user_id)
    )
  `);
  // Ensure progress column exists (in case table was created without it)
  await safeAlter(`
    ALTER TABLE group_challenge_participants
    ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0
  `, 'group_challenge_participants.progress');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_group_challenge_participants
    ON group_challenge_participants (challenge_id, progress DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_activities (
      id BIGSERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES study_groups(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      activity_type TEXT NOT NULL,
      content TEXT,
      activity_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_group_activities_group
    ON group_activities (group_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_member_mutes (
      id BIGSERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES study_groups(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      muted_until TIMESTAMP NOT NULL,
      reason TEXT,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (group_id, user_id)
    )
  `);

  // Voice check-in community
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_checkins (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT,
      audio_path TEXT,
      share_url TEXT,
      share_token TEXT,
      duration_sec REAL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_checkin_likes (
      id BIGSERIAL PRIMARY KEY,
      checkin_id BIGINT REFERENCES voice_checkins(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (checkin_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_checkin_comments (
      id BIGSERIAL PRIMARY KEY,
      checkin_id BIGINT REFERENCES voice_checkins(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_voice_checkins_time
    ON voice_checkins (created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_voice_checkins_share_token
    ON voice_checkins (share_token)
  `);
  await safeAlter(`
    ALTER TABLE voice_checkins
    ALTER COLUMN audio_path DROP NOT NULL
  `, 'voice_checkins.audio_path_nullable');
  await safeAlter(`
    ALTER TABLE voice_checkins
    ADD COLUMN IF NOT EXISTS share_url TEXT
  `, 'voice_checkins.share_url');
  await safeAlter(`
    ALTER TABLE voice_checkins
    ADD COLUMN IF NOT EXISTS share_token TEXT
  `, 'voice_checkins.share_token');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_checkin_ratings (
      id BIGSERIAL PRIMARY KEY,
      checkin_id BIGINT REFERENCES voice_checkins(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (checkin_id, user_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_voice_checkin_ratings_checkin
    ON voice_checkin_ratings (checkin_id)
  `);

  // Native review requests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS native_review_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT,
      audio_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS native_review_comments (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT REFERENCES native_review_requests(id) ON DELETE CASCADE,
      reviewer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Weekly focus cache
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_weekly_focus (
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      focus_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, week_start)
    )
  `);

  // Dictionary cache table (stores raw dictionary entry JSON)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dictionary_cache (
      word TEXT PRIMARY KEY,
      entry JSONB NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dictionary_cache_updated ON dictionary_cache(updated_at DESC)
  `);

  // Translation cache table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS translation_cache (
      word TEXT PRIMARY KEY,
      translation TEXT NOT NULL,
      source TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_translation_cache_updated ON translation_cache(updated_at DESC)
  `);

  // Suspicious translations table (for admin moderation)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suspicious_translations (
      id SERIAL PRIMARY KEY,
      lemma TEXT NOT NULL UNIQUE,
      translation TEXT,
      source TEXT,
      reasons TEXT[],
      user_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      detected_at TIMESTAMP DEFAULT NOW(),
      reviewed_at TIMESTAMP,
      reviewed_by INTEGER
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_suspicious_translations_status ON suspicious_translations(status)
  `);

  // ===== User Feedback tables =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      category VARCHAR(32) NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await safeAlter(`
    ALTER TABLE user_feedback
    ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb
  `, 'user_feedback.attachments');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_feedback_user ON user_feedback(user_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_feedback_replies (
      id BIGSERIAL PRIMARY KEY,
      feedback_id BIGINT REFERENCES user_feedback(id) ON DELETE CASCADE,
      author_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'admin',
      message TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // ===== Teacher / blogger workbench documents =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbench_documents (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'teacher',
      template_id TEXT NOT NULL DEFAULT 'intensive-note',
      source_text TEXT NOT NULL,
      annotated JSONB NOT NULL DEFAULT '{}'::jsonb,
      styles JSONB NOT NULL DEFAULT '{}'::jsonb,
      share_token TEXT UNIQUE,
      share_expires_at TIMESTAMP,
      practice_article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workbench_documents_user
    ON workbench_documents(user_id, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workbench_documents_share
    ON workbench_documents(share_token)
    WHERE share_token IS NOT NULL
  `);
}

module.exports = {
  ensureAuxTables,
};
