// Ajoute le role CONSULTATION_FOSA (MCC / ICP : consultation seule de leur FOSA)
// dans schema.prisma (enum Role) et dans la base de donnees.
// Sans danger : aucune donnee n'est modifiee ni supprimee. Peut etre relance.
// Confirmation typee obligatoire (AJOUTER) avant toute ecriture.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const prisma = require("../src/config/prisma");

const NOUVEAU_ROLE = "CONSULTATION_FOSA";

function demander(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(function (resolve) {
    rl.question(question, function (reponse) {
      rl.close();
      resolve(reponse);
    });
  });
}

async function main() {
  const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
  const contenu = fs.readFileSync(chemin, "utf8");
  const bloc = contenu.match(/enum Role\s*\{[^}]*\}/);

  if (!bloc) {
    console.log("ERREUR : l'enum Role est introuvable dans schema.prisma. Rien n'a ete modifie.");
    process.exit(1);
  }

  const dejaDansSchema = new RegExp("\\b" + NOUVEAU_ROLE + "\\b").test(bloc[0]);
  const valeursAvant = await prisma.$queryRawUnsafe(`SELECT unnest(enum_range(NULL::"Role"))::text AS v`);
  const dejaEnBase = valeursAvant.some(function (x) { return x.v === NOUVEAU_ROLE; });

  console.log("\nschema.prisma : " + (dejaDansSchema ? NOUVEAU_ROLE + " deja present." : NOUVEAU_ROLE + " sera ajoute a l'enum Role."));
  console.log("Base de donnees : " + (dejaEnBase ? NOUVEAU_ROLE + " deja present." : NOUVEAU_ROLE + " sera ajoute a l'enum Role."));
  console.log("Roles actuels en base : " + valeursAvant.map(function (x) { return x.v; }).join(", "));

  if (dejaDansSchema && dejaEnBase) {
    console.log("\nRien a faire.");
    return;
  }

  const reponse = await demander("\nTapez AJOUTER (en majuscules) pour appliquer, autre chose pour annuler : ");
  if (reponse.trim() !== "AJOUTER") {
    console.log("Annule : rien n'a ete modifie.");
    return;
  }

  if (!dejaDansSchema) {
    fs.writeFileSync(chemin + ".avant-consultation-fosa", contenu, "utf8");
    const nouveau = contenu.replace(
      /(enum Role\s*\{[^}]*?)(\r?\n)\}/,
      function (m, debut, saut) { return debut + saut + "  " + NOUVEAU_ROLE + saut + "}"; }
    );
    fs.writeFileSync(chemin, nouveau, "utf8");
    console.log("schema.prisma : " + NOUVEAU_ROLE + " ajoute (sauvegarde : schema.prisma.avant-consultation-fosa).");
  }

  await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS '${NOUVEAU_ROLE}'`);
  const valeurs = await prisma.$queryRawUnsafe(`SELECT unnest(enum_range(NULL::"Role"))::text AS v`);
  console.log("Base de donnees : valeurs de Role = " + valeurs.map(function (x) { return x.v; }).join(", "));
  console.log("\nIMPORTANT : arretez le serveur, lancez  npx prisma generate  puis relancez le serveur.");
}

main()
  .catch(function (e) {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(function () {
    return prisma.$disconnect();
  });