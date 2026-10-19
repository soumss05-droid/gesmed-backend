// Ajoute la colonne facultative « niveau » à la table etablissements (Neon).
// Additif et non destructif : aucune ligne existante n'est modifiée ni supprimée.
// Peut être relancé sans danger.
const prisma = require("../src/config/prisma");

async function main() {
  // 1. Le type énuméré, s'il n'existe pas déjà.
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NiveauFosa') THEN
        CREATE TYPE "NiveauFosa" AS ENUM (
          'HOPITAL',
          'CS_MOUGHATAA',
          'CS_SECONDAIRE',
          'PS_PRINCIPAL',
          'PS_SECONDAIRE',
          'UPEC_COMMUNAUTAIRE'
        );
      END IF;
    END
    $$;
  `);

  // 2. La colonne, vide par défaut.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "etablissements" ADD COLUMN IF NOT EXISTS "niveau" "NiveauFosa"`
  );

  // 3. Contrôle.
  const colonne = await prisma.$queryRawUnsafe(`
    SELECT column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'etablissements' AND column_name = 'niveau'
  `);
  const total = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "etablissements"`);
  const renseignes = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "etablissements" WHERE "niveau" IS NOT NULL`
  );

  console.log("Colonne :", JSON.stringify(colonne));
  console.log(`Établissements : ${total[0].n}, dont avec un niveau : ${renseignes[0].n}`);
}

main()
  .catch((err) => {
    console.error("Erreur :", err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());