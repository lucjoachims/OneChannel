# Mémo — canal privé 1:1

Un fil de discussion **entre deux personnes, jamais plus**, conçu autour d'un seul principe :

> **L'application ne demande jamais la permission de notifier → l'OS n'a rien à pousser → la montre, la voiture, la télé restent muettes.**

C'est *l'absence* de notification qui est la fonctionnalité. On ouvre l'app pour lire, point. Rien ne déborde sur un écran connecté.

---

## Ce que ça fait

- **Clé + code.** À la création, tu choisis une clé mémorisable (`Fête14Ans`) ; l'app génère un code aléatoire (`HR42K`). Les deux ensemble identifient et chiffrent le canal. Tu les transmets à l'autre personne *hors-bande* (de vive voix, SMS, papier).
- **Scellement à 2 appareils.** Les deux premiers appareils qui se présentent verrouillent le canal. Un troisième, même avec la bonne clé + le bon code, est **rejeté**.
- **Chiffrement côté client (AES-GCM).** Le serveur ne reçoit que `channel_id` (un hash de clé+code) et du contenu illisible. Il ne connaît ni la clé, ni le code, ni le texte, ni les fichiers, ni leurs noms.
- **Métadonnées loguées** (qui/quand/IP) — pour ta responsabilité d'hébergeur. Contenu illisible, métadonnées visibles : les deux cohabitent.
- **Asynchrone.** L'autre écrit à 14h, tu lis le soir. L'historique reste, propre.
- **« Vider ».** N'importe lequel des deux vide le fil pour les deux. La clé et le code restent valables : on reprend plus tard, sur un fil vierge.
- **Aucune notification, aucun push, aucun SMS, aucun e-mail.** Jamais.

---

## Arborescence

```
(racine web)
├── index.html              ← la PWA
├── app.js                  ← logique + chiffrement client
├── styles.css
├── manifest.webmanifest
├── sw.js                   ← service worker (cache uniquement, zéro push)
├── icon.svg
├── api/
│   ├── config.php          ← À REMPLIR (DB, dossier uploads, limites)
│   ├── db.php
│   ├── helpers.php
│   └── index.php           ← routeur API
├── uploads/                ← blobs chiffrés (protégé par .htaccess)
│   └── .htaccess
└── schema.sql              ← à importer dans MySQL
```

---

## Déploiement (5 étapes)

1. **Base de données.** Crée une base MySQL, puis importe `schema.sql` :
   ```bash
   mysql -u TON_USER -p TA_BASE < schema.sql
   ```

2. **Configuration.** Édite `api/config.php` : identifiants DB, et au besoin `MAX_MEDIA_BYTES`.

3. **Dossier uploads.** Vérifie que `uploads/` est **inscriptible** par PHP (`chmod 0700` ou 0755 selon l'hébergeur).
   - Idéalement, déplace-le **hors de la racine web** et mets à jour `UPLOAD_DIR` dans `config.php`. Sinon, le `.htaccess` fourni bloque l'accès direct (Apache).

4. **Limites PHP** (si tu veux des fichiers jusqu'à 8 Mo). Dans `php.ini` ou `.htaccess` :
   ```
   post_max_size = 10M
   upload_max_filesize = 10M
   ```

5. **HTTPS obligatoire.** WebCrypto et les service workers ne fonctionnent **que** sur `https://` (ou `http://localhost` en test). Sans HTTPS, l'app ne chiffrera pas et ne s'installera pas.

Ouvre l'URL → « Créer un canal » → note la clé + le code → l'autre fait « Ouvrir un canal » avec les deux. C'est tout.

---

## Discrétion : ce que tu peux régler

- **Nom + icône de la PWA installée** = le seul vrai point visible (dans une liste d'apps). Change-les dans `manifest.webmanifest`, `index.html` (`<title>`) et `icon.svg` pour quelque chose d'anodin qui te va.
- **URL neutre** : rien dans l'adresse ne doit crier « messagerie ».
- **Rien de déchiffrable n'est persisté** dans le navigateur : ni la clé, ni le code. Seul un jeton d'appareil secret (par canal) reste en `localStorage`, pour le scellement. À chaque session, on re-saisit clé + code.

---

## Sécurité — les choix faits

| Sujet | Choix |
|---|---|
| Clé devinable | Neutralisée par le **code aléatoire** : `channel_id = SHA-256(clé+code)`. Deux « FêteVendredi » donnent deux canaux différents. |
| Force de la clé | Vérifiée côté client (longueur, trivialité). Indicatif : le code porte l'entropie. |
| Brute-force du code | `channel_id` n'est jamais exposé ; viser un canal = deviner un hash. + **rate-limiting** par IP (`config.php`). |
| Contenu en DB | Chiffré AES-GCM côté client. Le serveur stocke de l'illisible. |
| Médias | Chiffrés côté client, servis uniquement après vérification d'appartenance. |
| 3e personne | Rejetée : le canal est scellé sur 2 jetons d'appareil. |

---

## Limites honnêtes (à connaître)

- **« Vider » n'efface que ce que le service contrôle.** Une capture d'écran, une image *téléchargée* sur l'appareil, le cache OS, les miniatures système : hors de portée d'une webapp. Le modèle de menace réaliste ici, c'est « quelqu'un jette un œil distrait », pas l'analyse forensique d'un téléphone saisi.
- **Changement d'appareil.** Le scellement est par appareil : si l'un de vous change de téléphone, le nouvel appareil ne sera pas reconnu si le canal est déjà plein. Prévoir un petit geste de ré-appairage (non inclus ici — un bouton « remplacer mon appareil » côté participant existant suffirait : supprimer la ligne `participants` correspondante).
- **Responsabilité d'hébergeur.** Tu héberges un canal : garde le mécanisme de log (IP/horodatage) et la capacité de couper un canal (`DELETE` en DB). Le « je ne vois rien » n'est pas, seul, une protection juridique fiable en Belgique/UE.
- **Pas de modération possible sur le contenu** (il est chiffré). C'est le revers assumé du chiffrement client. Garde-le pour un usage 1:1 légitime.

---

## Pistes d'amélioration (si tu veux aller plus loin)

- **TTL automatique** : un cron qui supprime messages + médias après N heures (`DELETE ... WHERE created_at < ...`).
- **Temps réel** : remplacer le polling (2,5 s) par SSE (Mercure) ou WebSocket pour l'instantané + l'indicateur « en train d'écrire ».
- **Ré-appairage d'appareil** : bouton décrit ci-dessus.
- **Indicateur de lecture** : ajouter `read_at` et un endpoint `mark_read`.
```
