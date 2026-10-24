// Ajoute les valeurs necessaires au circuit de destruction en trois temps
// (schema.prisma + base de donnees). Aucune donnee n'est modifiee ni supprimee.
// Peut etre relance sans danger.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

const AJOUTS = [
  { nom: "StatutDemandeDestruction", valeurs: ["AUTORISEE"] },
  { nom: "TypeNotification", valeurs: ["DESTRUCTION_AUTORISEE", "DESTRUCTION_REJETEE"] },
];

async function main() {
  const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
  const original = fs.readFileSync(chemin, "utf8");
  let contenu = original;

  for (const a of AJOUTS) {
    const re = new RegExp("enum " + a.nom + "\\s*\\{[^}]*\\}");
    if (!re.test(contenu)) {
      console.log("ERREUR : l'enum " + a.nom + " est introuvable dans schema.prisma. Rien n'a ete modifie.");
      process.exit(1);
    }
  }

  let modifie = false;
  for (const a of AJOUTS) {
    for (const v of a.valeurs) {
      const bloc = contenu.match(new RegExp("enum " + a.nom + "\\s*\\{[^}]*\\}"))[0];
      if (new RegExp("\\b" + v + "\\b").test(bloc)) {
        console.log("schema.prisma : " + v + " est deja present dans " + a.nom + ".");
        continue;
      }
      const re2 = new RegExp("(enum " + a.nom + "\\s*\\{[^}]*?)(\\r?\\n)\\}");
      contenu = contenu.replace(re2, function (m, debut, saut) {
        return debut + saut + "  " + v + saut + "}";
      });
      modifie = true;
      console.log("schema.prisma : " + v + " ajoute a " + a.nom + ".");
    }
  }

  if (modifie) {
    fs.writeFileSync(chemin + ".avant-circuit-destruction", original, "utf8");
    fs.writeFileSync(chemin, contenu, "utf8");
    console.log("Sauvegarde : schema.prisma.avant-circuit-destruction");
  }

  for (const a of AJOUTS) {
    for (const v of a.valeurs) {
      try {
        await prisma.$executeRawUnsafe(
          'ALTER TYPE "' + a.nom + '" ADD VALUE IF NOT EXISTS \'' + v + "'"
        );
      } catch (e) {
        console.log("ERREUR base (" + a.nom + " / " + v + ") : " + e.message.split("\n").pop());
        process.exitCode = 1;
      }
    }
    const valeurs = await prisma.$queryRawUnsafe(
      'SELECT unnest(enum_range(NULL::"' + a.nom + '"))::text AS v'
    );
    console.log("Base de donnees : " + a.nom + " = " + valeurs.map((x) => x.v).join(", "));
  }
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());