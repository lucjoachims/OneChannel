<?php
// =====================================================================
//  Connexion PDO
// =====================================================================
if (!is_file(__DIR__ . '/config.php')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'no_config',
        'detail' => 'Copie api/config.example.php vers api/config.php et remplis-le.']);
    exit;
}
require_once __DIR__ . '/config.php';

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = defined('DB_DSN') && DB_DSN
            ? DB_DSN
            : 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        $isSqlite = str_starts_with($dsn, 'sqlite:');
        $pdo = new PDO($dsn, $isSqlite ? null : DB_USER, $isSqlite ? null : DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        if ($isSqlite) $pdo->exec('PRAGMA foreign_keys = ON');
    }
    return $pdo;
}

/** Suffixe de verrouillage de ligne (MySQL uniquement ; SQLite verrouille la base). */
function for_update(): string {
    return db()->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
}
