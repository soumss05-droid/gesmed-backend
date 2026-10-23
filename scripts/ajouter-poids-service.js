const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

// Ajoute le "poids" d'un service (1 a 5, 1 par defaut) :
//   1. colonne "poids" dans la table services_programme (sans perte de donnees) ;
//   2. ligne correspondante dans le modele ServiceProgramme de prisma/schema.prisma.
const fichierSchema = path.join(__dirname, "..", "prisma", "schema.prisma");
const MOTIF_CIBLE = /(\n[ \t]*ciblePct[ \t]+Int\?[ \t]+@map\("cible_pct"\)[^\n]*)/g;
const LIGNE_POIDS = "\n  poids        Int                  @default(1)";

async function main() {
  // --- Verification du schema AVANT toute ecriture ---
  if (!fs.existsSync(fichierSchema)) {
    console.log("ERREUR : prisma/schema.prisma introuvable. Rien n'a ete modifie.");
    process.exit(1);
  }
  const brut = fs.readFileSync(fichierSchema, "utf8");
  const crlf = brut.includes("\r\n");
  const texte = crlf ? brut.replace(/\r\n/g, "\n") : brut;

  const bloc = texte.match(/model ServiceProgramme \{[\s\S]*?\n\}/);
  if (!bloc) {
    console.log("ERREUR : modele ServiceProgramme introuvable. Rien n'a ete modifie.");
    process.exit(1);
  }
  const schemaDejaFait = /\bpoids\b/.test(bloc[0]);
  if (!schemaDejaFait) {
    const nb = (bloc[0].match(MOTIF_CIBLE) || []).length;
    if (nb !== 1) {
      console.log(`ERREUR : ligne ciblePct attendue 1 fois dans le modele, trouvee ${nb}. Rien n'a ete modifie.`);
      process.exit(1);
    }
  }

  // --- 1. Base de donnees : ajout de la colonne (sans effet si elle existe deja) ---
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "services_programme" ADD COLUMN IF NOT EXISTS "poids" INTEGER NOT NULL DEFAULT 1'
  );
  const verif = await prisma.$queryRawUnsafe(
    "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'services_programme' AND column_name = 'poids'"
  );
  if (verif.length !== 1) {
    console.log("ERREUR : la colonne poids n'est pas visible dans la base. Schema laisse inchange.");
    process.exit(1);
  }
  console.log(`OK base : colonne poids presente (${verif[0].data_type}, defaut ${verif[0].column_default}).`);

  // --- 2. Schema Prisma ---
  if (schemaDejaFait) {
    console.log("Deja fait : le schema contient deja le poids.");
  } else {
    fs.copyFileSync(fichierSchema, fichierSchema + ".avant-poids");
    const nouveauBloc = bloc[0].replace(MOTIF_CIBLE, (m) => m + LIGNE_POIDS);
    const resultat = texte.replace(bloc[0], () => nouveauBloc);
    fs.writeFileSync(fichierSchema, crlf ? resultat.replace(/\n/g, "\r\n") : resultat, "utf8");
    console.log("OK schema : ligne poids ajoutee (sauvegarde : schema.prisma.avant-poids).");
  }
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());