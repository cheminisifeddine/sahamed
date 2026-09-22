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
2. Créer une base **D1** et un bucket **R2**.
3. Créer les clés d'accès **R2** (S3-compatible).
4. Écrire `<userData>/cloud-backup.json` :

```json
{
  "enabled": true,
  "intervalMinutes": 60,
  "accountId": "VOTRE_ACCOUNT_ID",
  "apiToken": "VOTRE_API_TOKEN",
  "d1DatabaseId": "VOTRE_D1_DATABASE_ID",
  "r2Bucket": "sahamed-backups",
  "r2Endpoint": "https://VOTRE_ACCOUNT_ID.r2.cloudflarestorage.com",
  "r2AccessKeyId": "VOTRE_R2_ACCESS_KEY_ID",
  "r2SecretAccessKey": "VOTRE_R2_SECRET_ACCESS_KEY"
}
```

- **R2** : copie binaire complète de `sahamed.db` (restore one-shot).
- **D1** : historique `backup_runs` + export JSON des tables critiques.

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
