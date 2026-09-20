# OneChannel — canal privé 1:1

Un fil de discussion **entre deux personnes, jamais plus**, conçu autour d'un seul principe :

> **L'application ne demande jamais la permission de notifier → l'OS n'a rien à pousser → la montre, la voiture, la télé restent muettes.**

C'est *l'absence* de notification qui est la fonctionnalité. On ouvre l'app pour lire, point. Rien ne déborde sur un écran connecté. Et rien ne s'installe sur le téléphone : c'est une simple page web, sans manifest ni service worker.

---

## Ce que ça fait

- **Création réservée à l'administrateur.** Seule la personne qui connaît `ADMIN_PASSWORD` (dans `api/config.php`) peut créer un canal. Personne d'autre ne peut se servir du serveur pour ouvrir ses propres fils. Rejoindre un canal existant ne demande que la clé et le code.
- **Clé + code.** À la création, tu choisis une clé mémorisable (`Fête14Ans`) ; l'app génère un code aléatoire (`HR42K`). Les deux ensemble identifient et chiffrent le canal. Tu les transmets à l'autre personne *hors-bande* (de vive voix, papier).
- **Scellement à 2 appareils.** Les deux premiers appareils qui se présentent verrouillent le canal. Un troisième, même avec la bonne clé + le bon code, est **rejeté**.
- **Chiffrement côté client (AES-GCM).** Le serveur ne reçoit que `channel_id` (un hash de clé+code) et du contenu illisible. Il ne connaît ni la clé, ni le code, ni le texte, ni les fichiers, ni leurs noms.
- **Éphémère : 1 heure.** Tout message et tout document de plus d'une heure est effacé par le serveur (réglable : `MESSAGE_TTL_SECONDS`). Aucun cron nécessaire : la purge se fait à chaque lecture. Un script `api/purge.php` existe si tu veux aussi nettoyer les canaux que personne ne rouvre.
- **Documents à ouverture unique.** Une image ou un fichier reçu s'affiche sous forme de carte « Appuyer pour voir · une seule fois ». Dès qu'il est ouvert, il est **détruit sur le serveur** (blob + message). L'image se voit dans une visionneuse et disparaît à sa fermeture ; un fichier est téléchargé. L'expéditeur voit sa carte s'évanouir au moment de l'ouverture.
- **« écrit… ».** Un point turquoise dans l'en-tête et des points animés dans le fil quand l'autre est en train d'écrire. Présence « en ligne / hors ligne » également.
- **Accusés.** Sous chacun de tes messages : `✓` envoyé, `✓✓` reçu (l'autre appareil l'a récupéré), `✓✓` en turquoise = lu (l'autre l'avait à l'écran).
- **PANIQUE.** Un appui, **sans confirmation** : le fil est vidé localement à l'instant, puis sur le serveur pour l'autre appareil. La clé et le code restent valables : on reprend plus tard, sur un fil vierge.
- **Déchiffrement visible.** Un message reçu apparaît d'abord brouillé, puis chaque caractère se stabilise vers le texte réel. Cosmétique (le vrai déchiffrement a déjà eu lieu), désactivé si le système demande moins d'animations.
- **Métadonnées loguées** (qui/quand/IP) — pour ta responsabilité d'hébergeur. Contenu illisible, métadonnées visibles : les deux cohabitent.
- **Aucune notification, aucun push, aucun SMS, aucun e-mail.** Jamais.

---

## Arborescence

```
(racine web)
├── index.html              ← la page (pas de PWA, pas d'installation)
├── app.js                  ← logique + chiffrement client
├── styles.css              ← thème sombre
├── icon.svg                ← favicon
├── api/
│   ├── config.example.php  ← À COPIER en config.php puis remplir
│   ├── config.php          ← (ignoré par git : DB, mot de passe admin, TTL…)
│   ├── db.php
│   ├── helpers.php
│   ├── index.php           ← routeur API
│   └── purge.php           ← purge CLI optionnelle (cron)
├── uploads/                ← blobs chiffrés (protégé par .htaccess)
│   └── .htaccess
├── schema.sql              ← à importer dans MySQL (nouvelle installation)
└── migrate-v2.sql          ← à jouer sur une base v1 existante
```

---

## Déploiement (5 étapes)

1. **Base de données.** Crée une base MySQL, puis importe `schema.sql` :
   ```bash
   mysql -u TON_USER -p TA_BASE < schema.sql
   ```
   Base déjà en place (version précédente) ? Joue plutôt `migrate-v2.sql`.

2. **Configuration.** Copie `api/config.example.php` en `api/config.php`, renseigne les identifiants DB et surtout **`ADMIN_PASSWORD`** (une phrase longue, connue de toi seul). `config.php` est dans `.gitignore` : ne le commite jamais.

3. **Dossier uploads.** Vérifie que `uploads/` est **inscriptible** par PHP (`chmod 0700` ou 0755 selon l'hébergeur).
   - Idéalement, déplace-le **hors de la racine web** et mets à jour `UPLOAD_DIR` dans `config.php`. Sinon, le `.htaccess` fourni bloque l'accès direct (Apache).

4. **Limites PHP** (si tu veux des fichiers jusqu'à 8 Mo). Dans `php.ini` ou `.htaccess` :
   ```
   post_max_size = 10M
   upload_max_filesize = 10M
   ```

5. **HTTPS obligatoire.** WebCrypto ne fonctionne **que** sur `https://` (ou `http://localhost` en test). Sans HTTPS, l'app ne chiffrera pas.

Ouvre l'URL → « Créer un canal » (mot de passe admin) → note la clé + le code → l'autre fait « Ouvrir un canal » avec les deux. C'est tout.

---

## API (résumé)

| Action | Méthode | Rôle |
|---|---|---|
| `create` | POST | Créer un canal. Exige `admin_password`. |
| `join` | POST | Rejoindre / revenir. Scelle à 2 appareils. |
| `send` | POST | Poster un message chiffré (`text` ou `media`). |
| `messages` | GET | Nouveaux messages, ids encore vivants, état du pair (en ligne, écrit, reçu, lu). Purge au passage. |
| `typing` | POST | « J'écris » / « j'ai arrêté ». |
| `read` | POST | « J'ai lu jusqu'au message n° X ». |
| `burn` | POST | Détruire un message et son média (document ouvert). |
| `upload` / `media` | POST / GET | Déposer / récupérer un blob chiffré. |
| `close` | POST | PANIQUE : tout effacer pour les deux. |

---

## Discrétion : ce que tu peux régler

- **Titre de la page** (`<title>` dans `index.html`) et `icon.svg` : mets quelque chose d'anodin si tu préfères.
- **URL neutre** : rien dans l'adresse ne doit crier « messagerie ».
- **Rien de déchiffrable n'est persisté** dans le navigateur : ni la clé, ni le code. Seul un jeton d'appareil secret (par canal) reste en `localStorage`, pour le scellement. À chaque session, on re-saisit clé + code.

---

## Sécurité — les choix faits

| Sujet | Choix |
|---|---|
| Qui peut créer | Uniquement l'admin : mot de passe comparé en temps constant (`hash_equals`), temporisation de 300 ms sur échec, rate-limit par IP. |
| Clé devinable | Neutralisée par le **code aléatoire** : `channel_id = SHA-256(clé+code)`. Deux « FêteVendredi » donnent deux canaux différents. |
| Brute-force du code | `channel_id` n'est jamais exposé ; viser un canal = deviner un hash. + **rate-limiting** par IP (`config.php`). |
| Contenu en DB | Chiffré AES-GCM côté client. Le serveur stocke de l'illisible. |
| Médias | Chiffrés côté client, servis uniquement après vérification d'appartenance, **détruits à la première ouverture**. |
| Durée de vie | 1 h maximum pour tout contenu, purge côté serveur. |
| 3e personne | Rejetée : le canal est scellé sur 2 jetons d'appareil. |

---

## Limites honnêtes (à connaître)

- **« Panique » et le TTL n'effacent que ce que le service contrôle.** Une capture d'écran, un fichier *téléchargé* sur l'appareil, le cache OS : hors de portée d'une webapp. Le modèle de menace réaliste ici, c'est « quelqu'un jette un œil distrait », pas l'analyse forensique d'un téléphone saisi.
- **« Reçu » / « lu » sont des signaux du client.** « Reçu » = l'autre app a récupéré le message (elle était ouverte). « Lu » = elle l'a affiché avec l'onglet visible. Un client modifié pourrait mentir ; entre deux personnes de confiance, c'est fidèle.
- **Changement d'appareil.** Le scellement est par appareil : si l'un de vous change de téléphone, le nouvel appareil ne sera pas reconnu si le canal est déjà plein. Supprimer la ligne `participants` correspondante en DB suffit à ré-appairer.
- **Responsabilité d'hébergeur.** Tu héberges un canal : garde le mécanisme de log (IP/horodatage) et la capacité de couper un canal (`DELETE` en DB). Le « je ne vois rien » n'est pas, seul, une protection juridique fiable en Belgique/UE.
- **Pas de modération possible sur le contenu** (il est chiffré). C'est le revers assumé du chiffrement client. Garde-le pour un usage 1:1 légitime.
