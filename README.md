# SahaMed

**SahaMed** — logiciel **100 % hors-ligne** de gestion de cabinet médical (Algérie).

Poste serveur Electron + interface web, base SQLite locale, postes secrets en réseau local.  
Aucune dépendance cloud obligatoire : le cabinet fonctionne sans Internet.

## Fonctionnalités

- Patients, consultations, ordonnances, rendez-vous
- Caisse / paiements, actes, motifs, médicaments
- Messagerie cabinet, statistiques, paramètres
- Mode serveur / poste secrétaire (réseau local)
- Impression ordonnances, photos patients
- **Sauvegarde Cloudflare optionnelle** (D1 + R2) — désactivée par défaut

## Démarrage

```bash
npm install
npm start
```

Première ouverture : assistant réseau → choisir **Serveur**.

Identifiant initial : `admin` / `admin`  
→ **changez le mot de passe immédiatement** (Paramètres → Utilisateurs).

## Structure

| Chemin | Rôle |
|--------|------|
| `electron/` | Processus principal, base sql.js, API locale, LAN |
| `dist/` | Interface React buildée (servie en local) |
| `tools/` | Utilitaires CLI (reset admin, export, backup cloud) |

## Données locales

| OS | Dossier |
|----|---------|
| Linux | `~/.config/SahaMed/` |
| Windows | `%APPDATA%\SahaMed\` |

Fichiers importants : `sahamed.db`, `network-mode.json`, `cloud-backup.json` (optionnel), `sessions.json`.

## Sauvegarde Cloudflare (optionnelle, hors-ligne d'abord)

Si vous n'avez **pas** de config, l'app reste purement locale — rien n'est envoyé.

1. Créer un [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens) : permissions **Account → D1 → Edit**, **Workers R2 → Edit**.
2. Créer un bucket **R2** (ex. `sahamed-backups`). Une base **D1** si vous voulez aussi l’historique SQL (optionnel — R2 seul suffit pour un restore binaire).
3. Écrire `<userData>/cloud-backup.json` :

```json
{
  "enabled": true,
  "intervalMinutes": 60,
  "accountId": "VOTRE_ACCOUNT_ID",
  "apiToken": "VOTRE_API_TOKEN",
  "d1DatabaseId": "VOTRE_D1_DATABASE_ID",
  "r2Bucket": "sahamed-backups"
}
```

- **R2** : copie binaire complète de `sahamed.db` via l’API Cloudflare (pas de clés S3).
- **D1** : historique `backup_runs` + export JSON des tables critiques (si `d1DatabaseId` renseigné).

> **Limite D1** : le plan gratuit accepte 10 bases par compte. Si ce quota est atteint, laissez `d1DatabaseId` vide — la sauvegarde R2 reste active.

Déclenchement manuel :

```bash
node tools/cloud-backup.js ~/.config/SahaMed
```

Depuis l'app (IPC) : canal `backup:cloud`.

## Identité produit

- Nom : **SahaMed**
- Paquet npm : `sahamed`
- Protocole local : `sahamed:///`
- Aucune DRM / compte distant requis.

## Licence

Usage propre du détenteur du dépôt. Adaptez `package.json` (`license`) selon votre distribution.
