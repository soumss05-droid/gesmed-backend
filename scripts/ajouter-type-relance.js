// Ajoute le type de notification RELANCE (schema.prisma + base de données).
// Sans danger : aucune donnée n'est modifiée ni supprimée. Peut être relancé.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

async function main() {
  // 1. schema.prisma
  const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
  const contenu = fs.readFileSync(chemin, "utf8");
  const bloc = contenu.match(/enum TypeNotification\s*\{[^}]*\}/);

  if (!bloc) {
    console.log("ERREUR : l'enum TypeNotification est introuvable dans schema.prisma. Rien n'a été modifié.");
    process.exit(1);
  }

  if (/\bRELANCE\b/.test(bloc[0])) {
    console.log("schema.prisma : RELANCE est déjà présent. Rien à faire.");
  } else {
    fs.writeFileSync(chemin + ".avant-relance", contenu, "utf8");
    const nouveau = contenu.replace(
      /(enum TypeNotification\s*\{[^}]*?)(\r?\n)\}/,
      (m, debut, saut) => `${debut}${saut}  RELANCE${saut}}`
    );
    fs.writeFileSync(chemin, nouveau, "utf8");
    console.log("schema.prisma : RELANCE ajouté (sauvegarde : schema.prisma.avant-relance).");
  }

  // 2. Base de données
  await prisma.$executeRawUnsafe(`ALTER TYPE "TypeNotification" ADD VALUE IF NOT EXISTS 'RELANCE'`);
  const valeurs = await prisma.$queryRawUnsafe(
    `SELECT unnest(enum_range(NULL::"TypeNotification"))::text AS v`
  );
  console.log("Base de données : valeurs de TypeNotification =", valeurs.map((x) => x.v).join(", "));
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());