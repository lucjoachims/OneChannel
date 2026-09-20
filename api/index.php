<?php
// =====================================================================
//  API — point d'entrée unique : api/index.php?action=...
//  Le serveur ne voit jamais la clé ni le code, seulement channel_id.
//  Le contenu est chiffré côté client. AUCUNE notification n'est émise.
//
//  Actions :
//    create   (POST) — créer un canal (mot de passe admin requis)
//    join     (POST) — rejoindre / revenir dans un canal
//    send     (POST) — poster un message chiffré (texte ou média)
//    messages (GET)  — nouveaux messages + état du pair (présence, frappe,
//                      reçu/lu) + liste des ids encore vivants
//    typing   (POST) — « je suis en train d'écrire » (ou plus)
//    read     (POST) — « j'ai lu jusqu'au message n° X »
//    burn     (POST) — détruire un message (document ouvert)
//    upload   (POST) — déposer un blob chiffré
//    media    (GET)  — récupérer un blob chiffré
//    close    (POST) — PANIQUE : tout effacer pour les deux
// =====================================================================
require_once __DIR__ . '/helpers.php';

if (DEBUG) { ini_set('display_errors', '1'); error_reporting(E_ALL); }

$action = $_GET['action'] ?? '';

/** Lit et valide (channel_id, device_token) depuis un tableau. */
function ids_from(array $src): array {
    $cid = $src['channel_id'] ?? null;
    $tok = $src['device_token'] ?? null;
    if (!valid_hex($cid, 64) || !valid_hex($tok, 64)) {
        json_out(400, ['error' => 'bad_params']);
    }
    return [$cid, $tok];
}

try {
    switch ($action) {

        // -------------------------------------------------------------
        //  CREATE — réservé à l'administrateur (mot de passe config.php).
        // -------------------------------------------------------------
        case 'create': {
            rate_limit('create', RL_MAX_CREATE);
            ensure_schema();
            $in = body_json();
            [$cid, $tok] = ids_from($in);
            $pw = $in['admin_password'] ?? '';
            if (!is_string($pw) || ADMIN_PASSWORD === '' || !hash_equals(ADMIN_PASSWORD, $pw)) {
                // Petite temporisation : rend la devinette encore plus lente.
                usleep(300000);
                json_out(403, ['error' => 'bad_admin']);
            }
            $pdo = db();
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
            json_out(200, ['ok' => true, 'role' => 'A', 'sealed' => false, 'closed_seq' => 0]);
        }

        // -------------------------------------------------------------
        //  JOIN — rejoindre un canal existant, ou y revenir.
        //  Scelle à 2 appareils ; un 3e est rejeté.
        // -------------------------------------------------------------
        case 'join': {
            rate_limit('join', RL_MAX_JOIN);
            ensure_schema();
            [$cid, $tok] = ids_from(body_json());
            $pdo = db();
            $pdo->beginTransaction();

            $st = $pdo->prepare('SELECT sealed, closed_seq FROM channels WHERE channel_id = ?' . for_update());
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
        //  SEND — poster un message (texte ou référence média), chiffré.
        // -------------------------------------------------------------
        case 'send': {
            $in = body_json();
            [$cid, $tok] = ids_from($in);
            $type = $in['type'] ?? '';
            $iv = $in['iv'] ?? '';
            $ct = $in['ciphertext'] ?? '';
            if (!in_array($type, ['text', 'media'], true) || !valid_b64($iv, 32)
                || !is_string($ct) || $ct === '' || strlen($ct) > 16000000) {
                json_out(400, ['error' => 'bad_payload']);
            }
            $role = require_member($cid, $tok);
            $pdo = db();
            $now = now_sql();
            $pdo->prepare(
                'INSERT INTO messages (channel_id, sender, type, iv, ciphertext, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)'
            )->execute([$cid, $role, $type, $iv, $ct, $now]);
            $id = (int)$pdo->lastInsertId();
            // Envoyer, c'est aussi arrêter d'écrire.
            $pdo->prepare('UPDATE participants SET typing_at = NULL, seen_at = ? WHERE channel_id = ? AND device_token = ?')
                ->execute([$now, $cid, $tok]);
            $pdo->prepare('UPDATE channels SET last_activity = ? WHERE channel_id = ?')
                ->execute([$now, $cid]);
            json_out(200, ['ok' => true, 'id' => $id, 'created_at' => $now]);
        }

        // -------------------------------------------------------------
        //  MESSAGES — nouveaux messages après ?after (id), état du pair,
        //  liste des ids vivants (pour retirer ce qui a expiré / brûlé).
        //  C'est aussi ici qu'on purge (aucun cron nécessaire).
        // -------------------------------------------------------------
        case 'messages': {
            [$cid, $tok] = ids_from($_GET);
            $after = (int)($_GET['after'] ?? 0);
            $role = require_member($cid, $tok);
            $pdo = db();

            purge_expired($cid);
            // De temps en temps, purge globale (canaux que personne ne rouvre).
            if (random_int(1, 25) === 1) purge_expired(null);

            $st = $pdo->prepare('SELECT sealed, closed_seq FROM channels WHERE channel_id = ?');
            $st->execute([$cid]);
            $c = $st->fetch();

            $st = $pdo->prepare(
                'SELECT id, sender, type, iv, ciphertext, created_at
                 FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT 500'
            );
            $st->execute([$cid, $after]);
            $msgs = $st->fetchAll();
            foreach ($msgs as &$m) { $m['id'] = (int)$m['id']; $m['ts'] = sql_ts($m['created_at']); }
            unset($m);

            $st = $pdo->prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY id ASC');
            $st->execute([$cid]);
            $alive = array_map('intval', array_column($st->fetchAll(), 'id'));

            // Je suis là ; et tout ce que je viens de recevoir est « reçu ».
            $maxId = $alive ? max($alive) : 0;
            $now = now_sql();
            $st = $pdo->prepare('SELECT last_delivered_id FROM participants WHERE channel_id = ? AND device_token = ?');
            $st->execute([$cid, $tok]);
            $myDelivered = (int)($st->fetch()['last_delivered_id'] ?? 0);
            $pdo->prepare('UPDATE participants SET seen_at = ?, last_delivered_id = ? WHERE channel_id = ? AND device_token = ?')
                ->execute([$now, max($myDelivered, $maxId), $cid, $tok]);

            // État de l'autre.
            $st = $pdo->prepare(
                'SELECT seen_at, typing_at, last_delivered_id, last_read_id
                 FROM participants WHERE channel_id = ? AND role <> ?'
            );
            $st->execute([$cid, $role]);
            $p = $st->fetch();
            $t = time();
            $peer = $p ? [
                'present'      => true,
                'online'       => sql_ts($p['seen_at'])   > $t - ONLINE_TTL_SECONDS,
                'typing'       => sql_ts($p['typing_at']) > $t - TYPING_TTL_SECONDS,
                'delivered_id' => (int)$p['last_delivered_id'],
                'read_id'      => (int)$p['last_read_id'],
            ] : ['present' => false, 'online' => false, 'typing' => false,
                 'delivered_id' => 0, 'read_id' => 0];

            json_out(200, [
                'ok'         => true,
                'sealed'     => (bool)$c['sealed'],
                'closed_seq' => (int)$c['closed_seq'],
                'now'        => $t,
                'ttl'        => MESSAGE_TTL_SECONDS,
                'messages'   => $msgs,
                'alive'      => $alive,
                'peer'       => $peer,
            ]);
        }

        // -------------------------------------------------------------
        //  TYPING — « j'écris » (typing: true) ou « j'ai arrêté » (false).
        // -------------------------------------------------------------
        case 'typing': {
            $in = body_json();
            [$cid, $tok] = ids_from($in);
            require_member($cid, $tok);
            $typing = !empty($in['typing']);
            db()->prepare('UPDATE participants SET typing_at = ?, seen_at = ? WHERE channel_id = ? AND device_token = ?')
                ->execute([$typing ? now_sql() : null, now_sql(), $cid, $tok]);
            json_out(200, ['ok' => true]);
        }

        // -------------------------------------------------------------
        //  READ — « j'ai lu jusqu'au message up_to » (ne recule jamais).
        // -------------------------------------------------------------
        case 'read': {
            $in = body_json();
            [$cid, $tok] = ids_from($in);
            $upTo = (int)($in['up_to'] ?? 0);
            require_member($cid, $tok);
            $pdo = db();
            $st = $pdo->prepare('SELECT last_read_id FROM participants WHERE channel_id = ? AND device_token = ?');
            $st->execute([$cid, $tok]);
            $cur = (int)($st->fetch()['last_read_id'] ?? 0);
            $pdo->prepare('UPDATE participants SET last_read_id = ?, seen_at = ? WHERE channel_id = ? AND device_token = ?')
                ->execute([max($cur, $upTo), now_sql(), $cid, $tok]);
            json_out(200, ['ok' => true]);
        }

        // -------------------------------------------------------------
        //  BURN — détruit un message et, le cas échéant, son média.
        //  Appelé par le destinataire dès qu'il a ouvert un document.
        // -------------------------------------------------------------
        case 'burn': {
            $in = body_json();
            [$cid, $tok] = ids_from($in);
            $mid = (int)($in['message_id'] ?? 0);
            $media = $in['media_id'] ?? null;
            if ($mid <= 0) json_out(400, ['error' => 'bad_params']);
            require_member($cid, $tok);
            $pdo = db();
            $pdo->prepare('DELETE FROM messages WHERE id = ? AND channel_id = ?')->execute([$mid, $cid]);
            if (valid_hex($media, 64)) {
                $st = $pdo->prepare('SELECT path FROM media WHERE media_id = ? AND channel_id = ?');
                $st->execute([$media, $cid]);
                if ($row = $st->fetch()) {
                    @unlink($row['path']);
                    $pdo->prepare('DELETE FROM media WHERE media_id = ?')->execute([$media]);
                }
            }
            json_out(200, ['ok' => true]);
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
            $path = rtrim(UPLOAD_DIR, '/') . '/' . $media_id . '.bin';
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
            [$cid, $tok] = ids_from($_GET);
            $mid = $_GET['media_id'] ?? null;
            if (!valid_hex($mid, 64)) json_out(400, ['error' => 'bad_params']);
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
        //  CLOSE (PANIQUE) — efface messages + médias des deux côtés.
        //  Le canal reste scellé aux 2 appareils : on peut reprendre.
        // -------------------------------------------------------------
        case 'close': {
            [$cid, $tok] = ids_from(body_json());
            require_member($cid, $tok);
            $pdo = db();
            $pdo->beginTransaction();
            wipe_channel($pdo, $cid);
            $pdo->prepare(
                'UPDATE channels SET closed_seq = closed_seq + 1, last_activity = ? WHERE channel_id = ?'
            )->execute([now_sql(), $cid]);
            $pdo->prepare('UPDATE participants SET last_delivered_id = 0, last_read_id = 0, typing_at = NULL WHERE channel_id = ?')
                ->execute([$cid]);
            $pdo->commit();
            $st = $pdo->prepare('SELECT closed_seq FROM channels WHERE channel_id = ?');
            $st->execute([$cid]);
            json_out(200, ['ok' => true, 'closed_seq' => (int)$st->fetch()['closed_seq']]);
        }

        // -------------------------------------------------------------
        //  HEALTH — diagnostic rapide : PHP, base, schéma, dossier uploads.
        //  Ne révèle rien de sensible ; pratique pour vérifier un déploiement.
        // -------------------------------------------------------------
        case 'health': {
            $out = ['ok' => true, 'php' => PHP_VERSION, 'db' => false, 'schema' => false,
                    'uploads_writable' => false, 'admin_password_set' => ADMIN_PASSWORD !== '' && ADMIN_PASSWORD !== 'change-moi-vraiment'];
            try {
                db()->query('SELECT 1');
                $out['db'] = true;
                $out['schema_added'] = ensure_schema();
                $out['schema'] = true;
            } catch (Throwable $e) { $out['ok'] = false; $out['db_error'] = $e->getMessage(); }
            if (!is_dir(UPLOAD_DIR)) @mkdir(UPLOAD_DIR, 0700, true);
            $out['uploads_writable'] = is_dir(UPLOAD_DIR) && is_writable(UPLOAD_DIR);
            if (!$out['uploads_writable'] || !$out['schema']) $out['ok'] = false;
            json_out($out['ok'] ? 200 : 500, $out);
        }

        default:
            json_out(404, ['error' => 'unknown_action']);
    }
} catch (Throwable $e) {
    // Le message d'erreur SQL/PHP aide à diagnostiquer un déploiement ; il ne
    // contient jamais de contenu (tout est chiffré côté client).
    $detail = DEBUG ? $e->getMessage() : preg_replace('/\s+/', ' ', substr($e->getMessage(), 0, 160));
    json_out(500, ['error' => 'server', 'detail' => $detail]);
}
