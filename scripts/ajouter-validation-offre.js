const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

// Validation de l'offre de service par le Medecin chef de la Moughataa (MCM) :
//   1. colonnes valeur_validee / validee_par_id / validee_le dans la table offres_service
//      (vides au depart, aucune donnee modifiee) ;
//   2. champs correspondants dans le modele OffreService de prisma/schema.prisma.
const fichierSchema = path.join(__dirname, "..", "prisma", "schema.prisma");
const MOTIF_UPDATED_AT = /(\n[ \t]*updatedAt[ \t]+DateTime[^\n]*)/g;
const LIGNES_VALIDATION =
  '\n  valeurValidee   Boolean?         @map("valeur_validee")' +
  '\n  valideeParId    String?          @map("validee_par_id")' +
  '\n  valideeLe       DateTime?        @map("validee_le")';

async function main() {
  // --- Verification du schema AVANT toute ecriture ---
  if (!fs.existsSync(fichierSchema)) {
    console.log("ERREUR : prisma/schema.prisma introuvable. Rien n'a ete modifie.");
    process.exit(1);
  }
  const brut = fs.readFileSync(fichierSchema, "utf8");
  const crlf = brut.includes("\r\n");
  const texte = crlf ? brut.replace(/\r\n/g, "\n") : brut;

  const bloc = texte.match(/model OffreService \{[\s\S]*?\n\}/);
  if (!bloc) {
    console.log("ERREUR : modele OffreService introuvable. Rien n'a ete modifie.");
    process.exit(1);
  }
  const schemaDejaFait = /\bvaleurValidee\b/.test(bloc[0]);
  if (!schemaDejaFait) {
    const nb = (bloc[0].match(MOTIF_UPDATED_AT) || []).length;
    if (nb !== 1) {
      console.log(`ERREUR : ligne updatedAt attendue 1 fois dans le modele, trouvee ${nb}. Rien n'a ete modifie.`);
      process.exit(1);
    }
  }

  // --- 1. Base de donnees : ajout des colonnes (sans effet si elles existent deja) ---
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "offres_service" ' +
      'ADD COLUMN IF NOT EXISTS "valeur_validee" BOOLEAN, ' +
      'ADD COLUMN IF NOT EXISTS "validee_par_id" TEXT, ' +
      'ADD COLUMN IF NOT EXISTS "validee_le" TIMESTAMP(3)'
  );
  const verif = await prisma.$queryRawUnsafe(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'offres_service' " +
      "AND column_name IN ('valeur_validee', 'validee_par_id', 'validee_le') ORDER BY column_name"
  );
  if (verif.length !== 3) {
    console.log(`ERREUR : ${verif.length} colonne(s) visible(s) sur 3. Schema laisse inchange.`);
    process.exit(1);
  }
  console.log("OK base : " + verif.map((c) => `${c.column_name} (${c.data_type})`).join(", "));

  // --- 2. Schema Prisma ---
  if (schemaDejaFait) {
    console.log("Deja fait : le schema contient deja les champs de validation.");
  } else {
    fs.copyFileSync(fichierSchema, fichierSchema + ".avant-validation");
    const nouveauBloc = bloc[0].replace(MOTIF_UPDATED_AT, (m) => m + LIGNES_VALIDATION);
    const resultat = texte.replace(bloc[0], () => nouveauBloc);
    fs.writeFileSync(fichierSchema, crlf ? resultat.replace(/\n/g, "\r\n") : resultat, "utf8");
    console.log("OK schema : champs de validation ajoutes (sauvegarde : schema.prisma.avant-validation).");
  }
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());