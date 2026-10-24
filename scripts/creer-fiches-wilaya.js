// Cree, pour chaque DRS (wilaya), un etablissement de type WILAYA (point d'attache du DRS, sans stock).
// 1) Essai a blanc : affiche ce qui serait cree, ne modifie rien.
// 2) Ne cree rien tant que vous ne tapez pas CREER a l'ecran. Peut etre relance sans doublon.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const readline = require("readline");
const prisma = require("../src/config/prisma");

function poserQuestion(texte) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(texte, (rep) => { rl.close(); resolve(rep); }));
}

function nomWilaya(nomDrs) {
  const court = String(nomDrs).replace(/^\s*(drs|dras)\s+/i, "").trim();
  return "Wilaya " + (court || nomDrs);
}

async function main() {
  const toutesDrs = await prisma.drs.findMany({ where: { actif: true }, orderBy: { nom: "asc" } });
  const existantes = await prisma.etablissement.findMany({ where: { type: "WILAYA" }, select: { drsId: true, nom: true } });
  const dejaFaites = new Set(existantes.map((e) => e.drsId));

  const aCreer = [];
  console.log("=== ESSAI A BLANC : rien n'est cree ===");
  for (const d of toutesDrs) {
    if (dejaFaites.has(d.id)) {
      console.log("existe deja | " + d.nom);
      continue;
    }
    const nom = nomWilaya(d.nom);
    aCreer.push({ drs: d, nom });
    console.log("a creer     | " + d.nom + "  ->  " + nom);
  }
  console.log("");
  console.log(aCreer.length + " fiche(s) a creer, " + (toutesDrs.length - aCreer.length) + " deja existante(s).");

  if (aCreer.length === 0) {
    console.log("Rien a faire.");
    return;
  }

  const rep = await poserQuestion("\nTapez CREER pour creer ces " + aCreer.length + " fiche(s), ou Entree pour annuler : ");
  if (rep.trim() !== "CREER") {
    console.log("Annule : rien n'a ete cree.");
    return;
  }

  let ok = 0;
  for (const a of aCreer) {
    try {
      await prisma.etablissement.create({
        data: { nom: a.nom, type: "WILAYA", aStockPhysique: false, drsId: a.drs.id },
      });
      ok++;
      console.log("Cree : " + a.nom);
    } catch (e) {
      console.log("ECHEC pour " + a.nom + " : " + e.message);
    }
  }
  console.log("");
  console.log(ok + " fiche(s) creee(s) sur " + aCreer.length + ".");
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());