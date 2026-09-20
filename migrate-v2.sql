-- =====================================================================
--  Migration v1 → v2 (base déjà en place). Nouvelle installation :
--  importe simplement schema.sql, ce fichier est inutile.
-- =====================================================================
ALTER TABLE participants
  ADD COLUMN seen_at   DATETIME NULL,
  ADD COLUMN typing_at DATETIME NULL,
  ADD COLUMN last_delivered_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN last_read_id      BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE messages ADD KEY idx_msg_created (created_at);
ALTER TABLE media    ADD KEY idx_media_created (created_at);
