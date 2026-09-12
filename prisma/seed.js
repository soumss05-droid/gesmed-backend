const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

// Liste des 15 DRS de Mauritanie — à ajuster avec les noms/codes officiels exacts.
const DRS = [
  { nom: "DRS Nouakchott Nord", code: "NKN" },
  { nom: "DRS Hodh Chargui", code: "HCH" },
  { nom: "DRS Hodh Gharbi", code: "HGH" },
  { nom: "DRS Assaba", code: "ASS" },
  { nom: "DRS Gorgol", code: "GOR" },
  { nom: "DRS Brakna", code: "BRK" },
  { nom: "DRS Trarza", code: "TRZ" },
  { nom: "DRS Adrar", code: "ADR" },
  { nom: "DRS Dakhlet Nouadhibou", code: "DNB" },
  { nom: "DRS Tagant", code: "TAG" },
  { nom: "DRS Guidimakha", code: "GDM" },
  { nom: "DRS Tiris Zemmour", code: "TZM" },
  { nom: "DRS Inchiri", code: "INC" },
  { nom: "DRS Nouakchott Ouest", code: "NKO" },
  { nom: "DRS Nouakchott Sud", code: "NKS" },
];

// Programmes de santé — chaque produit et chaque GAS Programme national
// est rattaché à l'un d'entre eux. "Autre" sert de filet de sécurité pour
// ce qui ne rentre dans aucune catégorie précise.
const PROGRAMMES = [
  { id: "programme-sida-hepatite", nom: "SIDA / Hépatite", code: "SIDA_HEP" },
  { id: "programme-tuberculose", nom: "Tuberculose", code: "TB" },
  { id: "programme-paludisme", nom: "Paludisme", code: "PALU" },
  { id: "programme-autre", nom: "Autre", code: "AUTRE" },
];

// Produits de démonstration, avec des seuils par défaut. Ceux-ci sont des
// médicaments essentiels génériques, rattachés au programme "Autre".
const PRODUITS = [
  { id: "prod-amoxicilline", nom: "Amoxicilline 500mg", forme: "Gélule", unite: "unité", seuilMinDefaut: 50, seuilMaxDefaut: 300, programmeId: "programme-autre" },
  { id: "prod-sro", nom: "Sels de réhydratation orale", forme: "Sachet", unite: "unité", seuilMinDefaut: 40, seuilMaxDefaut: 200, programmeId: "programme-autre" },
  { id: "prod-paracetamol", nom: "Paracétamol injectable", forme: "Ampoule 1g/10ml", unite: "unité", seuilMinDefaut: 20, seuilMaxDefaut: 100, programmeId: "programme-autre" },
  { id: "prod-ampicilline", nom: "Ampicilline 1g", forme: "Flacon injectable", unite: "unité", seuilMinDefaut: 30, seuilMaxDefaut: 150, programmeId: "programme-autre" },
];

async function main() {
  console.log("Chargement des 15 DRS...");
  for (const drs of DRS) {
    await prisma.drs.upsert({ where: { code: drs.code }, update: {}, create: drs });
  }
  const drsNouakchott = await prisma.drs.findUnique({ where: { code: "NKN" } });

  console.log("Chargement des programmes...");
  for (const programme of PROGRAMMES) {
    await prisma.programme.upsert({ where: { id: programme.id }, update: {}, create: programme });
  }

  console.log("Création de la CAMEC centrale...");
  const camec = await prisma.etablissement.upsert({
    where: { id: "camec-central" },
    update: {},
    create: { id: "camec-central", nom: "CAMEC central", type: "CAMEC", aStockPhysique: true },
  });

  console.log("Création du GAS Programme national (SIDA / Hépatite)...");
  await prisma.etablissement.upsert({
    where: { id: "gas-programme-national" },
    update: { nom: "GAS Programme national - SIDA / Hépatite", programmeId: "programme-sida-hepatite" },
    create: {
      id: "gas-programme-national",
      nom: "GAS Programme national - SIDA / Hépatite",
      type: "GAS_PROGRAMME_NATIONAL",
      aStockPhysique: false,
      programmeId: "programme-sida-hepatite",
    },
  });

  console.log("Création du GAS Programme national (Tuberculose)...");
  await prisma.etablissement.upsert({
    where: { id: "gas-programme-national-tb" },
    update: {},
    create: {
      id: "gas-programme-national-tb",
      nom: "GAS Programme national - Tuberculose",
      type: "GAS_PROGRAMME_NATIONAL",
      aStockPhysique: false,
      programmeId: "programme-tuberculose",
    },
  });

  console.log("Création du GAS Programme national (Paludisme)...");
  await prisma.etablissement.upsert({
    where: { id: "gas-programme-national-palu" },
    update: {},
    create: {
      id: "gas-programme-national-palu",
      nom: "GAS Programme national - Paludisme",
      type: "GAS_PROGRAMME_NATIONAL",
      aStockPhysique: false,
      programmeId: "programme-paludisme",
    },
  });

  console.log("Création du GAS DRS Nouakchott...");
  const gasDrsNouakchott = await prisma.etablissement.upsert({
    where: { id: "gas-drs-nouakchott" },
    update: {},
    create: { id: "gas-drs-nouakchott", nom: "GAS DRS Nouakchott Nord", type: "GAS_DRS", aStockPhysique: true, drsId: drsNouakchott.id },
  });

    console.log("Création de la Moughataa d'Arafat...");
  const moughataaArafat = await prisma.moughataa.upsert({
    where: { id: "moughataa-arafat" },
    update: {},
    create: { id: "moughataa-arafat", nom: "Arafat", drsId: drsNouakchott.id },
  });

  console.log("Création du GAS Moughataa d'Arafat...");
  const gasMoughataaArafat = await prisma.etablissement.upsert({
    where: { id: "gas-moughataa-arafat" },
    update: { aStockPhysique: true },
    create: {
      id: "gas-moughataa-arafat",
      nom: "GAS Moughataa d'Arafat",
      type: "GAS_MOUGHATAA",
      aStockPhysique: true,
      drsId: drsNouakchott.id,
      moughataaId: moughataaArafat.id,
    },
  });
  
  console.log("Création de la formation sanitaire CS Arafat 2...");
  const csArafat2 = await prisma.etablissement.upsert({
    where: { id: "cs-arafat-2" },
    update: {},
    create: {
      id: "cs-arafat-2",
      nom: "CS Arafat 2",
      type: "FORMATION_SANITAIRE",
      aStockPhysique: true,
      drsId: drsNouakchott.id,
      moughataaId: moughataaArafat.id,
    },
  });

  console.log("Rattachement des produits à leur programme...");
  for (const produit of PRODUITS) {
    await prisma.produit.upsert({ where: { id: produit.id }, update: { programmeId: produit.programmeId }, create: produit });
  }

  console.log("Création des lots et stocks de démonstration pour CS Arafat 2...");
  const dansUnMois = new Date();
  dansUnMois.setDate(dansUnMois.getDate() + 12);
  const dansTroisSemaines = new Date();
  dansTroisSemaines.setDate(dansTroisSemaines.getDate() + 23);
  const dansLongtemps = new Date();
  dansLongtemps.setFullYear(dansLongtemps.getFullYear() + 1);

  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-amoxicilline", etablissementId: csArafat2.id } },
    update: {},
    create: { produitId: "prod-amoxicilline", etablissementId: csArafat2.id, quantiteTotale: 0, seuilMin: 50, seuilMax: 300, statut: "RUPTURE" },
  });

  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-sro", etablissementId: csArafat2.id } },
    update: {},
    create: { produitId: "prod-sro", etablissementId: csArafat2.id, quantiteTotale: 0, seuilMin: 40, seuilMax: 200, statut: "RUPTURE" },
  });

  await prisma.lot.upsert({
    where: { id: "lot-paracetamol-1" },
    update: {},
    create: { id: "lot-paracetamol-1", produitId: "prod-paracetamol", etablissementId: csArafat2.id, numeroLot: "LOT-2409", datePeremption: dansUnMois, quantite: 4 },
  });
  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-paracetamol", etablissementId: csArafat2.id } },
    update: {},
    create: { produitId: "prod-paracetamol", etablissementId: csArafat2.id, quantiteTotale: 4, seuilMin: 20, seuilMax: 100, statut: "SOUS_SEUIL" },
  });

  await prisma.lot.upsert({
    where: { id: "lot-ampicilline-1" },
    update: {},
    create: { id: "lot-ampicilline-1", produitId: "prod-ampicilline", etablissementId: csArafat2.id, numeroLot: "LOT-2377", datePeremption: dansTroisSemaines, quantite: 26 },
  });
  await prisma.lot.upsert({
    where: { id: "lot-ampicilline-2" },
    update: {},
    create: { id: "lot-ampicilline-2", produitId: "prod-ampicilline", etablissementId: csArafat2.id, numeroLot: "LOT-2501", datePeremption: dansLongtemps, quantite: 60 },
  });
  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-ampicilline", etablissementId: csArafat2.id } },
    update: {},
    create: { produitId: "prod-ampicilline", etablissementId: csArafat2.id, quantiteTotale: 86, seuilMin: 30, seuilMax: 150, statut: "NORMAL" },
  });

    console.log("Création des lots et stocks de démonstration pour le GAS Moughataa d'Arafat...");
  await prisma.lot.upsert({
    where: { id: "lot-moughataa-amoxicilline-1" },
    update: {},
    create: { id: "lot-moughataa-amoxicilline-1", produitId: "prod-amoxicilline", etablissementId: gasMoughataaArafat.id, numeroLot: "LOT-MOU-2412", datePeremption: dansLongtemps, quantite: 150 },
  });
  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-amoxicilline", etablissementId: gasMoughataaArafat.id } },
    update: {},
    create: { produitId: "prod-amoxicilline", etablissementId: gasMoughataaArafat.id, quantiteTotale: 150, seuilMin: 50, seuilMax: 300, statut: "NORMAL" },
  });

  await prisma.lot.upsert({
    where: { id: "lot-moughataa-sro-1" },
    update: {},
    create: { id: "lot-moughataa-sro-1", produitId: "prod-sro", etablissementId: gasMoughataaArafat.id, numeroLot: "LOT-MOU-2388", datePeremption: dansTroisSemaines, quantite: 30 },
  });
  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-sro", etablissementId: gasMoughataaArafat.id } },
    update: {},
    create: { produitId: "prod-sro", etablissementId: gasMoughataaArafat.id, quantiteTotale: 30, seuilMin: 40, seuilMax: 200, statut: "SOUS_SEUIL" },
  });

  await prisma.lot.upsert({
    where: { id: "lot-moughataa-paracetamol-1" },
    update: {},
    create: { id: "lot-moughataa-paracetamol-1", produitId: "prod-paracetamol", etablissementId: gasMoughataaArafat.id, numeroLot: "LOT-MOU-2450", datePeremption: dansUnMois, quantite: 90 },
  });
  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-paracetamol", etablissementId: gasMoughataaArafat.id } },
    update: {},
    create: { produitId: "prod-paracetamol", etablissementId: gasMoughataaArafat.id, quantiteTotale: 90, seuilMin: 20, seuilMax: 100, statut: "NORMAL" },
  });

  await prisma.stock.upsert({
    where: { produitId_etablissementId: { produitId: "prod-ampicilline", etablissementId: gasMoughataaArafat.id } },
    update: {},
    create: { produitId: "prod-ampicilline", etablissementId: gasMoughataaArafat.id, quantiteTotale: 0, seuilMin: 30, seuilMax: 150, statut: "RUPTURE" },
  });
  
  console.log("Création du stock central à la CAMEC (pour permettre les futures expéditions)...");
  for (const produit of PRODUITS) {
    await prisma.lot.upsert({
      where: { id: `lot-camec-${produit.id}` },
      update: {},
      create: {
        id: `lot-camec-${produit.id}`,
        produitId: produit.id,
        etablissementId: camec.id,
        numeroLot: `LOT-CAMEC-${produit.id.toUpperCase()}`,
        datePeremption: dansLongtemps,
        quantite: 2000,
      },
    });
    await prisma.stock.upsert({
      where: { produitId_etablissementId: { produitId: produit.id, etablissementId: camec.id } },
      update: {},
      create: { produitId: produit.id, etablissementId: camec.id, quantiteTotale: 2000, seuilMin: 200, seuilMax: 5000, statut: "NORMAL" },
    });
  }

  console.log("Création de l'Admin système (indépendant de tout établissement)...");
  const motDePasseAdmin = await bcrypt.hash("ChangeMoiRapidement123", 10);
  await prisma.utilisateur.upsert({
    where: { identifiant: "admin" },
    update: { estAdminSysteme: true },
    create: {
      nomComplet: "Administrateur système",
      identifiant: "admin",
      motDePasseHash: motDePasseAdmin,
      estAdminSysteme: true,
    },
  });

  console.log("Création du Gestionnaire CAMEC (rattaché à la CAMEC centrale)...");
  const motDePasseCamec = await bcrypt.hash("Camec123456", 10);
  const gestionnaireCamec = await prisma.utilisateur.upsert({
    where: { identifiant: "gestionnaire.camec" },
    update: {},
    create: { nomComplet: "Gestionnaire CAMEC", identifiant: "gestionnaire.camec", motDePasseHash: motDePasseCamec },
  });
  await prisma.userEtablissement.upsert({
    where: { utilisateurId_etablissementId: { utilisateurId: gestionnaireCamec.id, etablissementId: camec.id } },
    update: {},
    create: { utilisateurId: gestionnaireCamec.id, etablissementId: camec.id, role: "GESTIONNAIRE_CAMEC" },
  });

  console.log("Création d'un compte de démonstration pour CS Arafat 2 (rôle FORMATION_SANITAIRE)...");
  const motDePasseDemo = await bcrypt.hash("Demo123456", 10);
  const utilisateurCS = await prisma.utilisateur.upsert({
    where: { identifiant: "cs.arafat2" },
    update: {},
    create: { nomComplet: "Agent CS Arafat 2", identifiant: "cs.arafat2", motDePasseHash: motDePasseDemo },
  });
  await prisma.userEtablissement.upsert({
    where: { utilisateurId_etablissementId: { utilisateurId: utilisateurCS.id, etablissementId: csArafat2.id } },
    update: {},
    create: { utilisateurId: utilisateurCS.id, etablissementId: csArafat2.id, role: "FORMATION_SANITAIRE" },
  });

  console.log("Création d'un compte de démonstration pour le GAS DRS Nouakchott...");
  const utilisateurDrs = await prisma.utilisateur.upsert({
    where: { identifiant: "gas.drs.nouakchott" },
    update: {},
    create: { nomComplet: "Agent GAS DRS Nouakchott", identifiant: "gas.drs.nouakchott", motDePasseHash: motDePasseDemo },
  });
  await prisma.userEtablissement.upsert({
    where: { utilisateurId_etablissementId: { utilisateurId: utilisateurDrs.id, etablissementId: gasDrsNouakchott.id } },
    update: {},
    create: { utilisateurId: utilisateurDrs.id, etablissementId: gasDrsNouakchott.id, role: "GESTIONNAIRE_DRS" },
  });

  console.log("Création d'un compte de démonstration pour le GAS Moughataa d'Arafat...");
  const utilisateurMoughataa = await prisma.utilisateur.upsert({
    where: { identifiant: "gas.moughataa.arafat" },
    update: {},
    create: { nomComplet: "Agent GAS Moughataa Arafat", identifiant: "gas.moughataa.arafat", motDePasseHash: motDePasseDemo },
  });
  await prisma.userEtablissement.upsert({
    where: { utilisateurId_etablissementId: { utilisateurId: utilisateurMoughataa.id, etablissementId: gasMoughataaArafat.id } },
    update: {},
    create: { utilisateurId: utilisateurMoughataa.id, etablissementId: gasMoughataaArafat.id, role: "GAS_MOUGHATAA" },
  });

  console.log("Création d'un compte de démonstration pour le GAS Programme national (SIDA / Hépatite)...");
  const utilisateurProgNat = await prisma.utilisateur.upsert({
    where: { identifiant: "gas.programme.national" },
    update: {},
    create: { nomComplet: "Agent GAS Programme National - SIDA/Hépatite", identifiant: "gas.programme.national", motDePasseHash: motDePasseDemo },
  });
  await prisma.userEtablissement.upsert({
    where: { utilisateurId_etablissementId: { utilisateurId: utilisateurProgNat.id, etablissementId: "gas-programme-national" } },
    update: {},
    create: { utilisateurId: utilisateurProgNat.id, etablissementId: "gas-programme-national", role: "GAS_PROGRAMME_NATIONAL" },
  });

  console.log("\nSeed terminé. Comptes disponibles :");
  console.log("  - admin / ChangeMoiRapidement123 (Admin système, indépendant de tout établissement)");
  console.log("  - gestionnaire.camec / Camec123456 (Gestionnaire CAMEC, CAMEC central)");
  console.log("  - cs.arafat2 / Demo123456 (Formation sanitaire, CS Arafat 2)");
  console.log("  - gas.drs.nouakchott / Demo123456 (Gestionnaire DRS, GAS DRS Nouakchott Nord)");
  console.log("  - gas.moughataa.arafat / Demo123456 (GAS Moughataa, Arafat)");
  console.log("  - gas.programme.national / Demo123456 (GAS Programme national, SIDA/Hépatite)");
  console.log("Change ces mots de passe avant tout usage réel.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });