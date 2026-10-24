// Ajoute le type d'etablissement WILAYA (schema.prisma + base de donnees).
// Sans danger : aucune donnee n'est modifiee ni supprimee. Peut etre relance.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

async function main() {
  const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
  const contenu = fs.readFileSync(chemin, "utf8");
  const bloc = contenu.match(/enum TypeEtablissement\s*\{[^}]*\}/);

  if (!bloc) {
    console.log("ERREUR : l'enum TypeEtablissement est introuvable dans schema.prisma. Rien n'a ete modifie.");
    process.exit(1);
  }

  if (/\bWILAYA\b/.test(bloc[0])) {
    console.log("schema.prisma : WILAYA est deja present. Rien a faire.");
  } else {
    fs.writeFileSync(chemin + ".avant-wilaya", contenu, "utf8");
    const nouveau = contenu.replace(
      /(enum TypeEtablissement\s*\{[^}]*?)(\r?\n)\}/,
      (m, debut, saut) => debut + saut + "  WILAYA" + saut + "}"
    );
    fs.writeFileSync(chemin, nouveau, "utf8");
    console.log("schema.prisma : WILAYA ajoute (sauvegarde : schema.prisma.avant-wilaya).");
  }

  await prisma.$executeRawUnsafe(`ALTER TYPE "TypeEtablissement" ADD VALUE IF NOT EXISTS 'WILAYA'`);
  const valeurs = await prisma.$queryRawUnsafe(
    `SELECT unnest(enum_range(NULL::"TypeEtablissement"))::text AS v`
  );
  console.log("Base de donnees : valeurs de TypeEtablissement = " + valeurs.map((x) => x.v).join(", "));
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());