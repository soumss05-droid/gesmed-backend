# GesMed — Backend

Backend du logiciel de gestion des médicaments (Node.js + Express + PostgreSQL + Prisma).

Correspond aux **Lots 1 à 4** (socle, stocks, réquisitions, distribution/
réception/écarts), avec un premier départ sur le **Lot 5** (rapports —
tableaux de bord cloisonnés par périmètre). Le **Lot 6** (déploiement
pilote) reste à préparer sur le terrain, ainsi que tout le frontend
(React, en PWA) et les exports PDF/Excel.

## Installation

```bash
npm install
cp .env.example .env
# Renseigner DATABASE_URL avec les identifiants de ta base PostgreSQL (locale ou cloud)
# Générer une vraie valeur pour JWT_SECRET

npx prisma migrate dev --name init
npm run prisma:seed
npm run dev
```

Le serveur démarre sur `http://localhost:4000`. Vérifier avec :
```bash
curl http://localhost:4000/health
```

## Compte de démarrage

Après le seed, un compte Admin est créé :
- Identifiant : `admin`
- Mot de passe : `ChangeMoiRapidement123`

**À changer immédiatement après la première connexion.**

## Structure du projet

```
prisma/
  schema.prisma       — les 13 tables du modèle de données
  seed.js              — charge les 15 DRS + un compte Admin
src/
  config/prisma.js     — client de connexion à la base
  middleware/
    auth.js            — vérifie le token de connexion
    authorize.js        — vérifie que le rôle a le droit d'accéder à une route
  controllers/          — la logique métier de chaque fonctionnalité
  routes/                — les adresses (endpoints) de l'API
  index.js               — point de démarrage du serveur
```

## Endpoints disponibles à ce stade

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| POST | `/auth/login` | — | Connexion (identifiant + mot de passe) |
| GET | `/stocks` | tout utilisateur connecté | Stocks de son établissement, triés FEFO |
| POST | `/requisitions` | FORMATION_SANITAIRE | Créer une réquisition |
| GET | `/requisitions/a-valider` | tout niveau concerné | Réquisitions en attente à ce niveau |
| POST | `/requisitions/:id/decision` | tout niveau concerné | Valider, modifier ou rejeter |
| GET | `/distribution/pretes` | CAMEC / GAS DRS | Réquisitions validées prêtes à expédier |
| POST | `/distribution/:requisitionId/generer-bl` | CAMEC / GAS DRS | Génère un BL, sélectionne les lots en FEFO |
| GET | `/distribution/reception/en-attente` | tout établissement destinataire | BL reçus, pas encore confirmés |
| POST | `/distribution/reception/:blId/confirmer` | tout établissement destinataire | Confirme la réception, détecte les écarts |
| GET | `/ecarts/en-attente` | GAS_PROGRAMME_NATIONAL / AUDITEUR | Liste des écarts à arbitrer |
| POST | `/ecarts/:blLigneId/decision` | GAS_PROGRAMME_NATIONAL / AUDITEUR | Débloquer ou maintenir un écart |
| GET | `/rapports/tableau-de-bord` | tout utilisateur connecté | KPIs cloisonnés par périmètre |
| GET | `/rapports/produits-en-rupture` | tout utilisateur connecté | Classement des produits les plus en rupture |

## Ce qu'il reste à faire pour compléter le Lot 1

- Écran Admin pour créer/gérer les utilisateurs, Moughataa, formations sanitaires
- Fonction "mot de passe oublié"
- Blocage après plusieurs tentatives de connexion échouées

## Ce qu'il reste pour compléter le Lot 5

- Export PDF et Excel (actuellement, les endpoints renvoient du JSON — le frontend ou une librairie d'export doit générer les fichiers)
- Indicateurs supplémentaires : délai moyen de validation, taux de BL avec écart

## Prochaines étapes (Lot 6 et frontend)

Voir les fichiers `feuille-de-route-lots-developpement.md` et
`lots-2-a-6-detail-taches.md` pour le détail du Lot 6 (déploiement pilote).
Le frontend React (PWA) reprenant les maquettes reste entièrement à
développer.
