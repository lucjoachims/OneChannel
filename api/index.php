<?php
// =====================================================================
//  API — point d'entrée unique : api/index.php?action=...
//  Le serveur ne voit jamais la clé ni le code, seulement channel_id.
//  Le contenu est chiffré côté client. AUCUNE notification n'est émise.
// =====================================================================
require_once __DIR__ . '/helpers.php';

if (DEBUG) { ini_set('display_errors', '1'); error_reporting(E_ALL); }

$action = $_GET['action'] ?? '';

try {
    switch ($action) {

        // -------------------------------------------------------------
        //  CREATE — le créateur (rôle A) ouvre un canal.
        // -------------------------------------------------------------
        case 'create': {
            rate_limit('create', RL_MAX_CREATE);
            $in = body_json();
            $cid = $in['channel_id'] ?? null;
            $tok = $in['device_token'] ?? null;
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            $pdo = db();
            // Canal déjà existant ?
            $st = $pdo->prepare('SELECT sealed FROM channels WHERE channel_id = ?');
            $st->execute([$cid]);
            if ($st->fetch()) {
                // Déjà créé : c'est au second d'utiliser "join".
                json_out(409, ['error' => 'already_exists']);
            }
            $pdo->beginTransaction();
            $pdo->prepare(
                'INSERT INTO channels (channel_id, sealed, closed_seq, created_at, last_activity)
                 VALUES (?, 0, 0, ?, ?)'
            )->execute([$cid, now_sql(), now_sql()]);
            $pdo->prepare(
                'INSERT INTO participants (channel_id, device_token, role, ip, joined_at)
                 VALUES (?, ?, "A", ?, ?)'
            )->execute([$cid, $tok, client_ip_bin(), now_sql()]);
            $pdo->commit();
            json_out(200, ['ok' => true, 'role' => 'A', 'sealed' => false]);
        }

        // -------------------------------------------------------------
        //  JOIN — rejoindre un canal existant, ou y revenir.
        //  Scelle à 2 appareils ; un 3e est rejeté.
        // -------------------------------------------------------------
        case 'join': {
            rate_limit('join', RL_MAX_JOIN);
            $in = body_json();
            $cid = $in['channel_id'] ?? null;
            $tok = $in['device_token'] ?? null;
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            $pdo = db();
            $pdo->beginTransaction();

            $st = $pdo->prepare('SELECT sealed, closed_seq FROM channels WHERE channel_id = ? FOR UPDATE');
            $st->execute([$cid]);
            $chan = $st->fetch();
            if (!$chan) {
                $pdo->commit();
                json_out(404, ['error' => 'no_channel']); // clé/code inconnus
            }

            // Déjà participant ? On le laisse revenir.
            $st = $pdo->prepare('SELECT role FROM participants WHERE channel_id = ? AND device_token = ?');
            $st->execute([$cid, $tok]);
            $me = $st->fetch();
            if ($me) {
                $pdo->commit();
                json_out(200, ['ok' => true, 'role' => $me['role'],
                               'sealed' => (bool)$chan['sealed'],
                               'closed_seq' => (int)$chan['closed_seq']]);
            }

            // Sinon, place libre ?
            $st = $pdo->prepare('SELECT COUNT(*) c FROM participants WHERE channel_id = ?');
            $st->execute([$cid]);
            $count = (int)$st->fetch()['c'];
            if ($count >= 2) {
                $pdo->commit();
                json_out(403, ['error' => 'channel_full']);
            }

            $pdo->prepare(
                'INSERT INTO participants (channel_id, device_token, role, ip, joined_at)
                 VALUES (?, ?, "B", ?, ?)'
            )->execute([$cid, $tok, client_ip_bin(), now_sql()]);
            $pdo->prepare('UPDATE channels SET sealed = 1, last_activity = ? WHERE channel_id = ?')
                ->execute([now_sql(), $cid]);
            $pdo->commit();
            json_out(200, ['ok' => true, 'role' => 'B', 'sealed' => true,
                           'closed_seq' => (int)$chan['closed_seq']]);
        }

        // -------------------------------------------------------------
        //  STATUS — état du canal (scellé ? fermé depuis ?).
        // -------------------------------------------------------------
        case 'status': {
            $cid = $_GET['channel_id'] ?? null;
            $tok = $_GET['device_token'] ?? null;
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            require_member($cid, $tok);
            $st = db()->prepare('SELECT sealed, closed_seq FROM channels WHERE channel_id = ?');
            $st->execute([$cid]);
            $c = $st->fetch();
            json_out(200, ['ok' => true, 'sealed' => (bool)$c['sealed'],
                           'closed_seq' => (int)$c['closed_seq']]);
        }

        // -------------------------------------------------------------
        //  SEND — poster un message (texte ou référence média), chiffré.
        // -------------------------------------------------------------
        case 'send': {
            $in = body_json();
            $cid = $in['channel_id'] ?? null;
            $tok = $in['device_token'] ?? null;
            $type = $in['type'] ?? '';
            $iv = $in['iv'] ?? '';
            $ct = $in['ciphertext'] ?? '';
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            if (!in_array($type, ['text', 'media'], true) || !valid_b64($iv, 32)
                || !is_string($ct) || $ct === '' || strlen($ct) > 16000000) {
                json_out(400, ['error' => 'bad_payload']);
            }
            $role = require_member($cid, $tok);
            $pdo = db();
            $pdo->prepare(
                'INSERT INTO messages (channel_id, sender, type, iv, ciphertext, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)'
            )->execute([$cid, $role, $type, $iv, $ct, now_sql()]);
            $id = (int)$pdo->lastInsertId();
            $pdo->prepare('UPDATE channels SET last_activity = ? WHERE channel_id = ?')
                ->execute([now_sql(), $cid]);
            json_out(200, ['ok' => true, 'id' => $id]);
        }

        // -------------------------------------------------------------
        //  MESSAGES — liste les messages après ?after (id).
        //  Renvoie aussi closed_seq pour détecter un "Fermer" distant.
        // -------------------------------------------------------------
        case 'messages': {
            $cid = $_GET['channel_id'] ?? null;
            $tok = $_GET['device_token'] ?? null;
            $after = (int)($_GET['after'] ?? 0);
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            require_member($cid, $tok);
            $pdo = db();
            $st = $pdo->prepare('SELECT sealed, closed_seq FROM channels WHERE channel_id = ?');
            $st->execute([$cid]);
            $c = $st->fetch();

            $st = $pdo->prepare(
                'SELECT id, sender, type, iv, ciphertext, created_at
                 FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT 500'
            );
            $st->execute([$cid, $after]);
            $msgs = $st->fetchAll();
            json_out(200, [
                'ok' => true,
                'sealed' => (bool)$c['sealed'],
                'closed_seq' => (int)$c['closed_seq'],
                'messages' => $msgs,
            ]);
        }

        // -------------------------------------------------------------
        //  UPLOAD — dépose un blob déjà chiffré (octets bruts).
        //  En-têtes : X-Channel, X-Device, X-Iv (base64).
        //  Corps : ciphertext binaire. Renvoie media_id.
        // -------------------------------------------------------------
        case 'upload': {
            $cid = $_SERVER['HTTP_X_CHANNEL'] ?? '';
            $tok = $_SERVER['HTTP_X_DEVICE'] ?? '';
            $iv  = $_SERVER['HTTP_X_IV'] ?? '';
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64) || !valid_b64($iv, 32)) {
                json_out(400, ['error' => 'bad_params']);
            }
            require_member($cid, $tok);

            $bytes = file_get_contents('php://input');
            if ($bytes === false || $bytes === '') json_out(400, ['error' => 'empty']);
            if (strlen($bytes) > MAX_MEDIA_BYTES) json_out(413, ['error' => 'too_large']);

            if (!is_dir(UPLOAD_DIR)) @mkdir(UPLOAD_DIR, 0700, true);
            $media_id = bin2hex(random_bytes(32));
            $path = UPLOAD_DIR . '/' . $media_id . '.bin';
            if (file_put_contents($path, $bytes) === false) {
                json_out(500, ['error' => 'write_failed']);
            }
            db()->prepare(
                'INSERT INTO media (media_id, channel_id, iv, path, size, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)'
            )->execute([$media_id, $cid, $iv, $path, strlen($bytes), now_sql()]);
            json_out(200, ['ok' => true, 'media_id' => $media_id]);
        }

        // -------------------------------------------------------------
        //  MEDIA — renvoie le blob chiffré (le client déchiffre).
        // -------------------------------------------------------------
        case 'media': {
            $cid = $_GET['channel_id'] ?? null;
            $tok = $_GET['device_token'] ?? null;
            $mid = $_GET['media_id'] ?? null;
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64) || !valid_hex($mid, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            require_member($cid, $tok);
            $st = db()->prepare('SELECT path FROM media WHERE media_id = ? AND channel_id = ?');
            $st->execute([$mid, $cid]);
            $row = $st->fetch();
            if (!$row || !is_file($row['path'])) json_out(404, ['error' => 'no_media']);
            header('Content-Type: application/octet-stream');
            header('Content-Length: ' . filesize($row['path']));
            header('Cache-Control: no-store');
            readfile($row['path']);
            exit;
        }

        // -------------------------------------------------------------
        //  CLOSE — efface messages + médias des deux côtés.
        //  Le canal reste scellé aux 2 appareils : on peut reprendre.
        // -------------------------------------------------------------
        case 'close': {
            $in = body_json();
            $cid = $in['channel_id'] ?? null;
            $tok = $in['device_token'] ?? null;
            if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
                json_out(400, ['error' => 'bad_params']);
            }
            require_member($cid, $tok);
            $pdo = db();
            $pdo->beginTransaction();
            // Supprimer les fichiers médias sur disque.
            $st = $pdo->prepare('SELECT path FROM media WHERE channel_id = ?');
            $st->execute([$cid]);
            foreach ($st->fetchAll() as $m) { @unlink($m['path']); }
            $pdo->prepare('DELETE FROM media    WHERE channel_id = ?')->execute([$cid]);
            $pdo->prepare('DELETE FROM messages WHERE channel_id = ?')->execute([$cid]);
            $pdo->prepare(
                'UPDATE channels SET closed_seq = closed_seq + 1, last_activity = ? WHERE channel_id = ?'
            )->execute([now_sql(), $cid]);
            $pdo->commit();
            $st = $pdo->prepare('SELECT closed_seq FROM channels WHERE channel_id = ?');
            $st->execute([$cid]);
            json_out(200, ['ok' => true, 'closed_seq' => (int)$st->fetch()['closed_seq']]);
        }

        default:
            json_out(404, ['error' => 'unknown_action']);
    }
} catch (Throwable $e) {
    if (DEBUG) json_out(500, ['error' => 'server', 'detail' => $e->getMessage()]);
    json_out(500, ['error' => 'server']);
}
