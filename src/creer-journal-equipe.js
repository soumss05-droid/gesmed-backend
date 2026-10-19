// Crée la table journal_equipe (journal des créations faites par les GAS DRS).
//
// - Opération 100 % ADDITIVE : « CREATE TABLE IF NOT EXISTS ». Aucune table
//   existante n'est modifiée, aucune donnée n'est touchée ni supprimée.
// - Peut être relancé sans danger (si la table existe déjà, il ne fait rien).
// - Usage (dans le dossier gesmed-backend) :  node scripts/creer-journal-equipe.js
require("dotenv").config();
const prisma = require("../src/config/prisma");

async function main() {
  const avant = await prisma.$queryRawUnsafe(
    "SELECT to_regclass('public.journal_equipe') IS NOT NULL AS existe"
  );
  if (avant[0].existe) {
    console.log("La table journal_equipe existe déjà : rien à faire.");
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "journal_equipe" (
      "id" TEXT NOT NULL,
      "auteur_id" TEXT NOT NULL,
      "auteur_nom" TEXT NOT NULL,
      "drs_id" TEXT NOT NULL,
      "drs_nom" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "role" TEXT,
      "etablissement_nom" TEXT NOT NULL,
      "compte_nom" TEXT NOT NULL,
      "identifiant" TEXT NOT NULL,
      "lu" BOOLEAN NOT NULL DEFAULT false,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "journal_equipe_pkey" PRIMARY KEY ("id")
    )
  `);

  const apres = await prisma.$queryRawUnsafe(
    "SELECT to_regclass('public.journal_equipe') IS NOT NULL AS existe"
  );
  console.log(apres[0].existe ? "Table journal_equipe créée." : "ERREUR : la table n'a pas été créée.");
}

main()
  .catch((e) => {
    console.error("Échec :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());