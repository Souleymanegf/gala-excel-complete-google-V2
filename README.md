# Gala Black Excellence Noire 2027 — Google Sheets + Drive + Gmail

Cette version conserve l'interface React existante et remplace le stockage GitHub par :

- **Google Sheets** : base de données des candidatures.
- **Google Drive** : stockage des documents.
- **Gmail SMTP** : notifications et confirmations.
- **Node/Express** : API et protection des identifiants Google.

## Installation

```bash
npm install
```

Copier `.env.example` vers `.env`, puis remplir les variables.

## Google Cloud

Créer un projet Google Cloud et activer :

- Google Sheets API
- Google Drive API

Créer un **Service Account** et récupérer son adresse email ainsi que sa clé privée.

Partager le Google Sheet avec l'adresse email du Service Account avec le rôle **Éditeur**.

Créer un dossier Google Drive pour le Gala et le partager avec le Service Account avec le rôle **Éditeur**.

Les deux identifiants à placer dans `.env` sont :

- `GOOGLE_SHEET_ID`
- `GOOGLE_DRIVE_FOLDER_ID`

## Gmail

Pour Gmail avec SMTP :

1. Activer la validation en deux étapes du compte Gmail.
2. Créer un mot de passe d'application Google.
3. Mettre ce mot de passe dans `SMTP_PASS`.

Ne jamais mettre un mot de passe Gmail, un mot de passe d'application ou une clé Google dans React, `src/` ou GitHub.

## Développement

```bash
npm run dev
```

React démarre sur le port 5173 et Node sur le port 3001.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

## Stockage d'une candidature

Une soumission crée automatiquement :

```text
Google Drive
└── Gala Black Excellence 2027
    └── GBE2027-000001
        ├── document.pdf
        └── photo.jpg
```

et ajoute une ligne dans Google Sheets.

Le numéro de référence reste au format :

```text
GBE2027-000001
GBE2027-000002
GBE2027-000003
```

L'espace administrateur continue d'utiliser `/api/admin/candidatures` et `/api/admin/document`, donc le frontend existant n'a pas besoin de connaître les identifiants Google.

## Important

Le dossier Google Drive reste privé : le serveur télécharge les documents uniquement après authentification administrateur. Il n'utilise pas de permission publique "anyone".

Le fichier `.env` est volontairement absent de cette version.
