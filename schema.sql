-- =====================================================================
--  Canal privé 1:1 — schéma MySQL
--  Le serveur ne stocke JAMAIS la clé ni le code : seulement channel_id
--  (= SHA-256 de clé+code, calculé côté client). Le contenu des messages
--  et des médias est chiffré côté client (AES-GCM) : la DB ne contient
--  que de l'illisible. Les métadonnées (qui/quand/IP) sont, elles, loguées.
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
--  Un canal = un fil. Identifié par le hash de (clé + code).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  channel_id    CHAR(64)     NOT NULL,            -- SHA-256 hex (clé+code)
  sealed        TINYINT(1)   NOT NULL DEFAULT 0,  -- 1 quand les 2 appareils sont liés
  closed_seq    INT UNSIGNED NOT NULL DEFAULT 0,  -- incrémenté à chaque "Fermer"
  created_at    DATETIME     NOT NULL,
  last_activity DATETIME     NOT NULL,
  PRIMARY KEY (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  Au plus 2 participants par canal. L'identité = un jeton d'appareil
--  secret (généré et conservé côté client). C'est ce jeton qui scelle
--  le canal : un 3e appareil, même avec la bonne clé+code, est rejeté.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS participants (
  channel_id   CHAR(64)   NOT NULL,
  device_token CHAR(64)   NOT NULL,               -- secret, 32 octets hex
  role         CHAR(1)    NOT NULL,               -- 'A' (créateur) ou 'B'
  ip           VARBINARY(16) NULL,                -- log responsable (inet_pton)
  joined_at    DATETIME   NOT NULL,
  PRIMARY KEY (channel_id, device_token),
  KEY idx_part_channel (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  Messages : le contenu (ciphertext + iv) est opaque pour le serveur.
--  type = 'text' | 'media'. Pour 'media', le ciphertext décrypté côté
--  client contient { kind, media_id, name, mime }.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel_id CHAR(64)     NOT NULL,
  sender     CHAR(1)      NOT NULL,               -- 'A' ou 'B'
  type       VARCHAR(16)  NOT NULL,
  iv         VARCHAR(32)  NOT NULL,               -- base64 (12 octets)
  ciphertext MEDIUMTEXT   NOT NULL,               -- base64 AES-GCM
  created_at DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_msg_channel (channel_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  Médias : le fichier sur disque est déjà chiffré (octets AES-GCM).
--  Le serveur ne connaît ni le nom, ni le type réel, ni le contenu.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  media_id   CHAR(64)        NOT NULL,            -- aléatoire, sert de nom de fichier
  channel_id CHAR(64)        NOT NULL,
  iv         VARCHAR(32)     NOT NULL,            -- base64 (12 octets)
  path       VARCHAR(255)    NOT NULL,            -- chemin du blob chiffré
  size       INT UNSIGNED    NOT NULL,
  created_at DATETIME        NOT NULL,
  PRIMARY KEY (media_id),
  KEY idx_media_channel (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  Limitation de débit (création / ouverture) par IP. Hygiène anti
--  brute-force, même si channel_id encode déjà le code aléatoire.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rl (
  k            VARCHAR(96)  NOT NULL,             -- ex: "create:1.2.3.4"
  window_start INT UNSIGNED NOT NULL,
  cnt          INT UNSIGNED NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
