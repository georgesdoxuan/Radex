# Radex SaaS

Dashboard de veille concurrentielle centre sur les pages d'actualites des concurrents.

## Demarrage local

1. Copier les variables:
   - `cp .env.example .env`
2. Renseigner:
   - `OPENAI_API_KEY`
   - `SUPABASE_DB_URL`
3. Lancer:
   - `npm install`
   - `npm run dev`

`npm run dev` lance front + API dans un seul terminal, nettoie automatiquement un ancien process API sur `8787`, et recharge automatiquement le backend quand `server/index.mjs` change.
Le front Vite tourne sur `http://localhost:5173` (ou `5174` si `5173` est deja pris) et l'API sur `http://localhost:8787`.

## Setup Supabase (important)

- Utiliser la connection string Postgres du projet Supabase.
- Si le mot de passe contient des caracteres speciaux (`"`, `@`, `(`, etc.), il faut URL-encoder le mot de passe.
- Exemple de format:
  - `postgresql://postgres.<user>:<password-encode>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`

Au demarrage, le serveur cree automatiquement les tables:
- `monitored_sources`
- `source_articles`
- `monitor_runs`

## Sources suivies

- `https://blog.aubay.com/`
- `https://astekgroup.fr/innovation-ia-cyber/`
- `https://www.devoteam.com/fr/news-and-pr/`
- `https://www.wavestone.com/fr/decouvrir-wavestone/nos-actualites/`

## Endpoints API

- `GET /api/dashboard` : charge la vue SaaS
- `POST /api/run-analysis` : run manuel (detecte si nouvel article)
- `POST /api/run-test` : run test (prend le dernier article sans comparer la nouveaute)

## Plus tard: automation

Le endpoint `POST /api/cron/run` existe deja, mais tu peux rester en run manuel pour le moment.
