<?php
// =====================================================================
//  Purge en ligne de commande (OPTIONNELLE).
//  La purge est déjà faite à chaque lecture par l'API ; ce script sert
//  seulement à nettoyer les canaux que personne ne rouvre jamais.
//  Exemple de cron :   */15 * * * *  php /chemin/vers/api/purge.php
// =====================================================================
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/helpers.php';
purge_expired(null);
echo "ok\n";
