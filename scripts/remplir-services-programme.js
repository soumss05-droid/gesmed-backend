// Remplit les 16 services de l'indicateur d'offre de service.
// Sans danger : ne modifie jamais un service déjà présent (les cibles restent intactes).
// À lancer APRÈS creer-offre-service.js et npx prisma generate.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const prisma = require("../src/config/prisma");

// [code, programme, groupe, nom, dépendance]
const SERVICES = [
  ["VIH_DEPISTAGE", "SIDA_HEP", "VIH", "Dépistage", "PRODUITS"],
  ["VIH_PTME", "SIDA_HEP", "VIH", "PTME", "PRODUITS"],
  ["VIH_ARV", "SIDA_HEP", "VIH", "ARV (traitement)", "PRODUITS"],
  ["VIH_DPN", "SIDA_HEP", "VIH", "Diagnostic précoce du nourrisson", "EQUIPEMENT"],
  ["VIH_CV", "SIDA_HEP", "VIH", "Charge virale", "EQUIPEMENT"],

  ["HEPB_DEPISTAGE", "SIDA_HEP", "Hépatite B", "Dépistage", "PRODUITS"],
  ["HEPB_CV", "SIDA_HEP", "Hépatite B", "Charge virale", "EQUIPEMENT"],
  ["HEPB_TRAITEMENT", "SIDA_HEP", "Hépatite B", "Mise sous traitement", "PRODUITS"],
  ["HEPB_VACCINATION", "SIDA_HEP", "Hépatite B", "Vaccination de l'enfant", "PRODUITS"],

  ["PALU_TDR", "PALU", "Paludisme", "TDR", "PRODUITS"],
  ["PALU_ACT", "PALU", "Paludisme", "Traitement ACT", "PRODUITS"],
  ["PALU_GE", "PALU", "Paludisme", "Goutte épaisse (GE)", "EQUIPEMENT"],
  ["PALU_PEC_GRAVE", "PALU", "Paludisme", "Prise en charge du paludisme grave", "PERSONNEL"],

  ["TB_TRAITEMENT", "TB", "Tuberculose", "Traitement", "PRODUITS"],
  ["TB_BACILLOSCOPIE", "TB", "Tuberculose", "Bacilloscopie", "EQUIPEMENT"],
  ["TB_MOLECULAIRE", "TB", "Tuberculose", "Diagnostic moléculaire", "EQUIPEMENT"],
];

async function main() {
  const programmes = await prisma.programme.findMany({ select: { id: true, code: true } });
  const parCode = Object.fromEntries(programmes.map((p) => [p.code, p.id]));

  const manquants = [...new Set(SERVICES.map((s) => s[1]))].filter((c) => !parCode[c]);
  if (manquants.length > 0) {
    console.log("ERREUR : programmes introuvables dans la base :", manquants.join(", "));
    console.log("Rien n'a été créé.");
    process.exitCode = 1;
    return;
  }

  let crees = 0;
  let existants = 0;

  for (let i = 0; i < SERVICES.length; i++) {
    const [code, codeProgramme, groupe, nom, dependance] = SERVICES[i];
    const deja = await prisma.serviceProgramme.findUnique({ where: { code } });
    if (deja) {
      existants++;
      continue;
    }
    await prisma.serviceProgramme.create({
      data: { code, programmeId: parCode[codeProgramme], groupe, nom, dependance, ordre: i + 1 },
    });
    crees++;
  }

  const total = await prisma.serviceProgramme.count();
  console.log(`Services créés : ${crees} | déjà présents : ${existants} | total en base : ${total}`);
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());