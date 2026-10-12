// Répare le rattachement des formations sanitaires à leur DRS.
// Cas visé : FOSA créées par l'import (moughataaId renseigné, drsId vide) :
// le filtre « DRS » de l'administration et les vues par DRS ne les voient pas.
//
// Ce script ne SUPPRIME RIEN. Il ne fait qu'une chose : renseigner drsId
// (= la DRS de la moughataa de la FOSA) là où il est vide.
//   - il ne touche jamais une FOSA dont le drsId est déjà renseigné ;
//   - il ne touche ni aux comptes, ni aux stocks, ni à l'historique ;
//   - par défaut c'est une SIMULATION : il liste ce qu'il corrigerait.
//
// Usage (depuis D:\gesmed\gesmed-backend) :
//   node scripts/reparer-drs-fosa.js              -> simulation (rien n'est modifié)
//   node scripts/reparer-drs-fosa.js --appliquer  -> applique après confirmation
const readline = require("readline");
const prisma = require("../src/config/prisma");

const APPLIQUER = process.argv.includes("--appliquer");

function hoteVise() {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/@([^/:?]+)/);
  return m ? m[1] : "(inconnue)";
}

function demander(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (r) => { rl.close(); resolve(r); }));
}

async function main() {
  console.log(APPLIQUER ? "MODE : APPLICATION" : "MODE : SIMULATION (rien ne sera modifié)");
  console.log("Base visée :", hoteVise());
  console.log("");

  const fosa = await prisma.etablissement.findMany({
    where: { type: "FORMATION_SANITAIRE" },
    select: {
      id: true,
      nom: true,
      drsId: true,
      moughataaId: true,
      moughataa: { select: { nom: true, drsId: true, drs: { select: { nom: true } } } },
    },
    orderBy: { nom: "asc" },
  });

  const aCorriger = fosa.filter((f) => !f.drsId && f.moughataa && f.moughataa.drsId);
  const sansMoughataa = fosa.filter((f) => !f.moughataaId);
  const incoherentes = fosa.filter((f) => f.drsId && f.moughataa && f.moughataa.drsId && f.drsId !== f.moughataa.drsId);
  const dejaBien = fosa.length - aCorriger.length - sansMoughataa.length - incoherentes.length;

  console.log(`Formations sanitaires au total : ${fosa.length}`);
  console.log(`  Déjà rattachées à la bonne DRS : ${dejaBien}`);
  console.log(`  À CORRIGER (drsId vide)         : ${aCorriger.length}`);
  console.log(`  Sans moughataa (non traitées)   : ${sansMoughataa.length}`);
  console.log(`  Incohérentes (non touchées)     : ${incoherentes.length}`);
  console.log("");

  if (aCorriger.length > 0) {
    console.log("=== FOSA QUI RECEVRAIENT UNE DRS ===");
    for (const f of aCorriger) {
      console.log(`  ${f.nom.padEnd(32)} moughataa ${f.moughataa.nom.padEnd(20)} -> ${f.moughataa.drs?.nom || f.moughataa.drsId}`);
    }
    console.log("");
  }
  if (sansMoughataa.length > 0) {
    console.log("=== FOSA SANS MOUGHATAA (à traiter à la main) ===");
    for (const f of sansMoughataa) console.log(`  ${f.nom}`);
    console.log("");
  }
  if (incoherentes.length > 0) {
    console.log("=== FOSA DONT LA DRS DIFFÈRE DE CELLE DE LEUR MOUGHATAA (laissées telles quelles) ===");
    for (const f of incoherentes) console.log(`  ${f.nom} (moughataa ${f.moughataa.nom})`);
    console.log("");
  }

  if (!APPLIQUER) {
    console.log("SIMULATION terminée : rien n'a été modifié.");
    if (aCorriger.length > 0) console.log("Pour appliquer : node scripts/reparer-drs-fosa.js --appliquer");
    return;
  }
  if (aCorriger.length === 0) {
    console.log("Rien à corriger.");
    return;
  }

  const reponse = await demander(`Tape CORRIGER pour renseigner la DRS de ces ${aCorriger.length} FOSA : `);
  if (reponse.trim() !== "CORRIGER") {
    console.log("Annulé : rien n'a été modifié.");
    return;
  }

  let faites = 0;
  await prisma.$transaction(async (tx) => {
    for (const f of aCorriger) {
      // Condition drsId: null : on ne modifie jamais une valeur déjà renseignée.
      const r = await tx.etablissement.updateMany({
        where: { id: f.id, drsId: null },
        data: { drsId: f.moughataa.drsId },
      });
      faites += r.count;
    }
  });
  console.log(`Terminé : ${faites} FOSA rattachée(s) à leur DRS.`);
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch {}
    process.exit(process.exitCode || 0);
  });