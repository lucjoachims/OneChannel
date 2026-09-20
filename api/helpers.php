<?php
// =====================================================================
//  Helpers communs
// =====================================================================
require_once __DIR__ . '/db.php';

/** Envoie une réponse JSON et termine. */
function json_out(int $code, array $data): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

/** Lit et décode le corps JSON de la requête. */
function body_json(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

/** IP du client au format binaire (pour stockage VARBINARY). */
function client_ip_bin(): ?string {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    // Si tu es derrière un proxy de confiance, adapte ici (X-Forwarded-For).
    $bin = @inet_pton($ip);
    return $bin === false ? null : $bin;
}

function client_ip_str(): string {
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

/** Vrai si $s est une chaîne hex de longueur $len exactement. */
function valid_hex(?string $s, int $len): bool {
    return is_string($s) && strlen($s) === $len && ctype_xdigit($s);
}

/** base64 court (iv) — validation souple. */
function valid_b64(?string $s, int $maxLen = 64): bool {
    return is_string($s) && $s !== '' && strlen($s) <= $maxLen
        && preg_match('/^[A-Za-z0-9+\/=]+$/', $s) === 1;
}

/**
 * Vérifie que (channel_id, device_token) est bien un participant du canal.
 * Renvoie le rôle ('A'|'B'). Sinon coupe en 403.
 */
function require_member(string $channel_id, string $device_token): string {
    $st = db()->prepare(
        'SELECT role FROM participants WHERE channel_id = ? AND device_token = ?'
    );
    $st->execute([$channel_id, $device_token]);
    $row = $st->fetch();
    if (!$row) json_out(403, ['error' => 'not_member']);
    return $row['role'];
}

/**
 * Limitation de débit simple par clé (ex "create:<ip>").
 * Coupe en 429 si dépassement.
 */
function rate_limit(string $action, int $max): void {
    $k = $action . ':' . client_ip_str();
    $now = time();
    $winStart = $now - (RL_WINDOW);
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare('SELECT window_start, cnt FROM rl WHERE k = ? FOR UPDATE');
        $st->execute([$k]);
        $row = $st->fetch();
        if (!$row || $row['window_start'] < $winStart) {
            $up = $pdo->prepare(
                'REPLACE INTO rl (k, window_start, cnt) VALUES (?, ?, 1)'
            );
            $up->execute([$k, $now]);
        } else {
            if ((int)$row['cnt'] >= $max) {
                $pdo->commit();
                json_out(429, ['error' => 'rate_limited']);
            }
            $up = $pdo->prepare('UPDATE rl SET cnt = cnt + 1 WHERE k = ?');
            $up->execute([$k]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        // En cas de souci sur le rate-limit, on ne bloque pas l'usage légitime.
    }
}

function now_sql(): string { return gmdate('Y-m-d H:i:s'); }
