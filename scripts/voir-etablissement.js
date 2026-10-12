// Lecture seule : affiche les établissements dont le nom contient un mot.
// Usage : node scripts/voir-etablissement.js taleb
const prisma = require("../src/config/prisma");

async function main() {
  const mot = process.argv[2];
  if (!mot) {
    console.log("Donne un mot à chercher, par exemple : node scripts/voir-etablissement.js taleb");
    return;
  }
  const liste = await prisma.etablissement.findMany({
    where: { nom: { contains: mot, mode: "insensitive" } },
    include: { moughataa: { include: { drs: true } }, drs: true },
  });
  if (liste.length === 0) {
    console.log(`Aucun établissement ne contient "${mot}".`);
    return;
  }
  for (const e of liste) {
    console.log("----------------------------------------");
    console.log("Nom           :", e.nom);
    console.log("Type          :", e.type);
    console.log("Actif         :", e.actif);
    console.log("Moughataa     :", e.moughataa ? e.moughataa.nom : "(AUCUNE)");
    console.log("DRS (via Moughataa) :", e.moughataa && e.moughataa.drs ? e.moughataa.drs.nom : "(aucun)");
    console.log("DRS (direct)  :", e.drs ? e.drs.nom : "(aucun)");
  }
}

main()
  .catch((err) => console.error("Erreur :", err.message))
  .finally(() => prisma.$disconnect());