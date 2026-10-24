// Ajoute la colonne "cause" (PERIME par defaut) aux demandes de destruction.
// Sans danger : aucune donnee n'est modifiee ni supprimee. Peut etre relance.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

async function main() {
  const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
  const contenu = fs.readFileSync(chemin, "utf8");
  const bloc = contenu.match(/model DemandeDestructionLot\s*\{[^}]*\}/);

  if (!bloc) {
    console.log("ERREUR : le modele DemandeDestructionLot est introuvable. Rien n'a ete modifie.");
    process.exit(1);
  }

  if (/\bcause\b/.test(bloc[0])) {
    console.log("schema.prisma : la colonne cause est deja presente. Rien a faire.");
  } else {
    const lignes = bloc[0].split(/\r?\n/);
    const idx = lignes.findIndex((l) => l.indexOf("motifDemande") !== -1);
    if (idx === -1) {
      console.log("ERREUR : ligne motifDemande introuvable. Rien n'a ete modifie.");
      process.exit(1);
    }
    lignes.splice(idx + 1, 0, '  cause                 String                   @default("PERIME")');
    const saut = contenu.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
    const nouveauBloc = lignes.join(saut);
    fs.writeFileSync(chemin + ".avant-cause", contenu, "utf8");
    fs.writeFileSync(chemin, contenu.replace(bloc[0], function () { return nouveauBloc; }), "utf8");
    console.log("schema.prisma : cause ajoutee (sauvegarde : schema.prisma.avant-cause).");
  }

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "demandes_destruction_lots" ADD COLUMN IF NOT EXISTS "cause" TEXT NOT NULL DEFAULT 'PERIME'`
  );
  const res = await prisma.$queryRawUnsafe(
    `SELECT cause, COUNT(*)::int AS n FROM "demandes_destruction_lots" GROUP BY cause`
  );
  console.log("Base de donnees : demandes par cause =", JSON.stringify(res));
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());