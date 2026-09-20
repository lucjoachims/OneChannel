<?php
// =====================================================================
//  Configuration — copie ce fichier en  api/config.php  puis remplis-le.
//  api/config.php est ignoré par git : il ne doit JAMAIS être commité.
// =====================================================================

// ---- Base de données (MySQL / MariaDB) --------------------------------
define('DB_HOST',    'localhost');
define('DB_NAME',    'onechannel');
define('DB_USER',    'onechannel');
define('DB_PASS',    'change-moi');
define('DB_CHARSET', 'utf8mb4');
// Optionnel : DSN PDO complet (prioritaire sur DB_HOST/DB_NAME). Sert
// surtout aux tests locaux, ex. 'sqlite:/tmp/onechannel.sqlite'.
// define('DB_DSN', 'sqlite:/tmp/onechannel.sqlite');

// ---- Mot de passe administrateur -------------------------------------
//  Seule la personne qui connaît ce mot de passe peut CRÉER un canal.
//  Rejoindre un canal existant (clé + code) ne le demande pas.
//  Choisis une phrase longue ; il n'est jamais transmis à l'autre personne.
define('ADMIN_PASSWORD', 'change-moi-vraiment');

// ---- Médias -------------------------------------------------------------
//  Dossier des blobs chiffrés. Idéalement HORS de la racine web.
define('UPLOAD_DIR',      __DIR__ . '/../uploads');
define('MAX_MEDIA_BYTES', 8 * 1024 * 1024);   // 8 Mo

// ---- Durées ------------------------------------------------------------
define('MESSAGE_TTL_SECONDS', 3600);   // les messages disparaissent après 1 h
define('TYPING_TTL_SECONDS',  4);      // « écrit… » reste affiché 4 s après la dernière frappe
define('ONLINE_TTL_SECONDS',  8);      // « en ligne » = a interrogé le serveur il y a moins de 8 s

// ---- Limitation de débit (par IP) --------------------------------------
define('RL_WINDOW',     600);  // fenêtre en secondes
define('RL_MAX_CREATE', 10);   // tentatives de création (bon ou mauvais mot de passe)
define('RL_MAX_JOIN',   30);   // tentatives d'ouverture

// ---- Debug ---------------------------------------------------------------
define('DEBUG', false);
