const prisma = require("../config/prisma");

function calculerStatut(quantite, seuilMin, seuilMax) {
  if (quantite <= 0) return "RUPTURE";
  if (quantite < seuilMin) return "SOUS_SEUIL";
  if (quantite > seuilMax) return "SURSTOCK";
  return "NORMAL";
}

// Coefficients utilisés pour calculer dynamiquement les seuils min/max de
// chaque établissement à partir de sa consommation réelle : CMM (dispensation
// aux patients) pour une formation sanitaire, DMM propre (sorties BL vers le
// niveau du dessous) pour les niveaux qui redistribuent. Ajustables selon la
// politique nationale de stock de sécurité — la formation sanitaire garde ici
// exactement les mêmes valeurs qu'avant (0.5 mois / 3 mois).
const COEFFICIENTS_SEUILS = {
  FORMATION_SANITAIRE: { min: 0.5, max: 3 },
  GAS_MOUGHATAA: { min: 1, max: 3 },
  GAS_DRS: { min: 2, max: 6 },
  CAMEC: { min: 3, max: 12 },
};

// Recalcule et enregistre le statut d'un stock à partir de sa quantité
// actuelle et de ses seuils — à appeler systématiquement après TOUT
// changement de quantiteTotale, pour que le statut ne reste jamais figé sur
// une ancienne valeur (ex. "RUPTURE" qui persiste après une rentrée).
//
// Pour tout établissement détenant un stock physique (formation sanitaire,
// GAS Moughataa, GAS DRS, CAMEC), les seuils eux-mêmes sont aussi recalculés
// dynamiquement à partir de sa propre consommation (CMM pour la dispensation,
// DMM propre pour les niveaux qui redistribuent) — bien plus pertinent qu'un
// seuil générique identique partout. Tant qu'aucun historique de sortie
// n'existe encore pour ce produit à ce niveau (produit tout juste introduit
// dans le réseau), on ne peut pas juger d'un éventuel surstock : seule une
// vraie rupture (quantité nulle) est signalée, le reste est classé "NORMAL"
// en attendant d'avoir assez de recul.
async function recalculerStatutStock(produitId, etablissementId) {
  const stock = await prisma.stock.findUnique({
    where: { produitId_etablissementId: { produitId, etablissementId } },
  });
  if (!stock) return null;

  const etablissement = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    select: { type: true },
  });

  const coefficients = etablissement?.type ? COEFFICIENTS_SEUILS[etablissement.type] : null;

  let seuilMin = stock.seuilMin;
  let seuilMax = stock.seuilMax;
  let statut;

  if (coefficients) {
    const referenceType = etablissement.type === "FORMATION_SANITAIRE" ? "DISPENSATION" : "BL";
    const cmmMap = await cmmParProduit(etablissementId, referenceType);
    const cmm = cmmMap[produitId] || 0;

    if (cmm > 0) {
      seuilMin = Math.round(cmm * coefficients.min);
      seuilMax = Math.round(cmm * coefficients.max);
      statut = calculerStatut(stock.quantiteTotale, seuilMin, seuilMax);
    } else {
      statut = stock.quantiteTotale <= 0 ? "RUPTURE" : "NORMAL";
    }
  } else {
    statut = calculerStatut(stock.quantiteTotale, seuilMin, seuilMax);
  }

  if (statut === stock.statut && seuilMin === stock.seuilMin && seuilMax === stock.seuilMax) return stock;
  return prisma.stock.update({
    where: { produitId_etablissementId: { produitId, etablissementId } },
    data: { seuilMin, seuilMax, statut },
  });
}

// Crée un lot chez le destinataire d'une réception (réplique du lot
// d'origine expédié) — ou, s'il existe déjà un lot avec ce même numéro chez
// cet établissement (cas fréquent : un même lot source livré à plusieurs
// reprises au même destinataire), augmente simplement sa quantité au lieu
// d'en créer un doublon, ce qui violerait la règle d'unicité (un numéro de
// lot est unique par établissement, sa péremption invariante). Sans cette
// vérification, la deuxième réception d'un même lot échouait avec une
// erreur de contrainte non gérée.
async function creerOuIncrementerLot({ produitId, etablissementId, numeroLot, datePeremption, quantite, fournisseur, prixUnitaire, note, dateReception }) {
  const lotExistant = await prisma.lot.findUnique({
    where: { etablissementId_numeroLot: { etablissementId, numeroLot } },
  });

  if (lotExistant) {
    if (lotExistant.produitId !== produitId) {
      throw new Error(
        `Le numéro de lot "${numeroLot}" est déjà utilisé pour un autre produit à cet établissement.`
      );
    }
    return prisma.lot.update({
      where: { id: lotExistant.id },
      data: { quantite: { increment: quantite } },
    });
  }

  return prisma.lot.create({
    data: {
      produitId,
      etablissementId,
      numeroLot,
      datePeremption,
      quantite,
      ...(fournisseur !== undefined ? { fournisseur } : {}),
      ...(prixUnitaire !== undefined ? { prixUnitaire } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(dateReception !== undefined ? { dateReception } : {}),
    },
  });
}

// GET /stocks
// Retourne les stocks de l'établissement connecté, avec les lots associés
// triés en FEFO (date de péremption la plus proche en premier).
async function listerStocks(req, res) {
  const { etablissementId } = req.utilisateur;
  const stocks = await prisma.stock.findMany({
    where: { etablissementId },
    include: { produit: true },
  });

  const stocksAvecLots = await Promise.all(
    stocks.map(async (stock) => {
      const lots = await prisma.lot.findMany({
        where: { produitId: stock.produitId, etablissementId, quantite: { gt: 0 } },
        orderBy: { datePeremption: "asc" }, // FEFO
      });
      return {
        produitId: stock.produitId,
        produit: stock.produit.nom,
        quantiteTotale: stock.quantiteTotale,
        seuilMin: stock.seuilMin,
        seuilMax: stock.seuilMax,
        statut: stock.statut,
        lots: lots.map((l) => ({
          id: l.id,
          numeroLot: l.numeroLot,
          datePeremption: l.datePeremption,
          quantite: l.quantite,
        })),
      };
    })
  );

  return res.json(stocksAvecLots);
}

// Fonction utilitaire réutilisable par les autres lots (réquisitions, réception)
// pour sélectionner le lot à sortir en priorité selon la logique FEFO.
async function selectionnerLotFEFO(produitId, etablissementId, quantiteNecessaire) {
  const lots = await prisma.lot.findMany({
    where: { produitId, etablissementId, quantite: { gt: 0 } },
    orderBy: { datePeremption: "asc" },
  });

  const lotsChoisis = [];
  let restant = quantiteNecessaire;
  for (const lot of lots) {
    if (restant <= 0) break;
    const quantitePrise = Math.min(lot.quantite, restant);
    lotsChoisis.push({ lotId: lot.id, quantite: quantitePrise });
    restant -= quantitePrise;
  }

  return { lotsChoisis, quantiteNonCouverte: restant };
}

async function stockReseau(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  if (role === "GESTIONNAIRE_CAMEC") {
    const toutesLesDrs = await prisma.drs.findMany({ orderBy: { nom: "asc" } });
    const resultatCamec = [];

    const stocksCamec = await prisma.stock.findMany({
      where: { etablissementId },
      include: { produit: true },
    });
    const maintenant = new Date();
    const lotsPerimesCamec = await prisma.lot.findMany({
      where: { etablissementId, quantite: { gt: 0 }, datePeremption: { lt: maintenant } },
      include: { produit: true },
    });
    resultatCamec.push({
      etablissementId,
      etablissementNom: etablissement.nom,
      type: "CAMEC",
      regionNom: null,
      moughataaNom: null,
      stocks: stocksCamec.map((s) => ({
        produitId: s.produitId,
        produit: s.produit.nom,
        quantiteTotale: s.quantiteTotale,
        statut: s.statut,
      })),
      lotsPerimes: lotsPerimesCamec.map((l) => ({
        produit: l.produit.nom,
        numeroLot: l.numeroLot,
        datePeremption: l.datePeremption,
        quantite: l.quantite,
      })),
    });

    for (const drs of toutesLesDrs) {
      const moughataasRegion = await prisma.moughataa.findMany({ where: { drsId: drs.id }, select: { id: true } });
      const moughataaIds = moughataasRegion.map((m) => m.id);
      const etabsRegion = await prisma.etablissement.findMany({
        where: {
          OR: [
            { type: "GAS_DRS", drsId: drs.id },
            { type: "GAS_MOUGHATAA", drsId: drs.id },
            { type: "FORMATION_SANITAIRE", moughataaId: { in: moughataaIds } },
          ],
        },
        select: { id: true },
      });
      const etabRegionIds = etabsRegion.map((e) => e.id);
      if (etabRegionIds.length === 0) continue;

      const stocksRegion = await prisma.stock.findMany({
        where: { etablissementId: { in: etabRegionIds } },
        include: { produit: true },
      });
      const lotsPerimesRegion = await prisma.lot.findMany({
        where: { etablissementId: { in: etabRegionIds }, quantite: { gt: 0 }, datePeremption: { lt: maintenant } },
        include: { produit: true },
      });

      const totauxParProduit = {};
      for (const s of stocksRegion) {
        if (!totauxParProduit[s.produitId]) totauxParProduit[s.produitId] = { produit: s.produit.nom, quantiteTotale: 0 };
        totauxParProduit[s.produitId].quantiteTotale += s.quantiteTotale;
      }

      resultatCamec.push({
        etablissementId: drs.id,
        etablissementNom: drs.nom,
        type: "GAS_DRS",
        regionNom: drs.nom,
        moughataaNom: null,
        stocks: Object.entries(totauxParProduit).map(([produitId, v]) => ({
          produitId,
          produit: v.produit,
          quantiteTotale: v.quantiteTotale,
          statut: null,
        })),
        lotsPerimes: lotsPerimesRegion.map((l) => ({
          produit: l.produit.nom,
          numeroLot: l.numeroLot,
          datePeremption: l.datePeremption,
          quantite: l.quantite,
        })),
      });
    }

    return res.json(resultatCamec);
  }

  let etablissementsCibles = [];
  const inclureHierarchie = { moughataa: { include: { drs: true } }, drs: true };

  if (role === "ADMIN") {
    etablissementsCibles = await prisma.etablissement.findMany({
      orderBy: { nom: "asc" },
      include: inclureHierarchie,
    });
  } else if (role === "GAS_PROGRAMME_NATIONAL") {
    etablissementsCibles = await prisma.etablissement.findMany({
      where: { type: "GAS_DRS" },
      include: inclureHierarchie,
    });
  } else if (role === "GESTIONNAIRE_DRS" || role === "DIRECTEUR_DRS") {
    const moughataasRegion = await prisma.moughataa.findMany({
      where: { drsId: etablissement.drsId },
      select: { id: true },
    });
    const moughataaIds = moughataasRegion.map((m) => m.id);
    etablissementsCibles = await prisma.etablissement.findMany({
      where: {
        OR: [
          { id: etablissementId },
          { type: "GAS_MOUGHATAA", drsId: etablissement.drsId },
          { type: "FORMATION_SANITAIRE", moughataaId: { in: moughataaIds } },
        ],
      },
      include: inclureHierarchie,
    });
  } else if (role === "GAS_MOUGHATAA" || role === "MEDECIN_CHEF_MOUGHATAA") {
    etablissementsCibles = await prisma.etablissement.findMany({
      where: {
        OR: [
          { id: etablissementId },
          { type: "FORMATION_SANITAIRE", moughataaId: etablissement.moughataaId },
        ],
      },
      include: inclureHierarchie,
    });
  } else {
    return res.status(403).json({ erreur: "Cette vue n'est pas disponible pour ton rôle." });
  }

  etablissementsCibles.sort((a, b) => {
    if (a.id === etablissementId) return -1;
    if (b.id === etablissementId) return 1;
    return 0;
  });

  const etablissementIds = etablissementsCibles.map((e) => e.id);

  const filtreProduit =
    role === "GAS_PROGRAMME_NATIONAL" && etablissement.programmeId
      ? { produit: { programmeId: etablissement.programmeId } }
      : {};

  const stocks = await prisma.stock.findMany({
    where: { etablissementId: { in: etablissementIds }, ...filtreProduit },
    include: { produit: true },
  });

  const maintenant = new Date();
  const lotsPerimes = await prisma.lot.findMany({
    where: {
      etablissementId: { in: etablissementIds },
      quantite: { gt: 0 },
      datePeremption: { lt: maintenant },
      ...(filtreProduit.produit ? { produit: filtreProduit.produit } : {}),
    },
    include: { produit: true },
  });

  function nomAffichage(etab) {
    if (etab.type === "GAS_MOUGHATAA" && etab.moughataa?.nom) return `Moughataa ${etab.moughataa.nom}`;
    if (etab.type === "GAS_DRS" && etab.drs?.nom) return etab.drs.nom;
    return etab.nom;
  }

  function nomRegion(etab) {
    if (etab.type === "GAS_DRS") return etab.drs?.nom || null;
    return etab.moughataa?.drs?.nom || null;
  }
  function nomMoughataaGroupe(etab) {
    if (etab.type === "GAS_MOUGHATAA" || etab.type === "FORMATION_SANITAIRE") return etab.moughataa?.nom || null;
    return null;
  }

  const resultat = etablissementsCibles.map((etab) => ({
    etablissementId: etab.id,
    etablissementNom: nomAffichage(etab),
    type: etab.type,
    regionNom: nomRegion(etab),
    moughataaNom: nomMoughataaGroupe(etab),
    stocks: stocks
      .filter((s) => s.etablissementId === etab.id)
      .map((s) => ({
        produitId: s.produitId,
        produit: s.produit.nom,
        quantiteTotale: s.quantiteTotale,
        statut: s.statut,
      })),
    lotsPerimes: lotsPerimes
      .filter((l) => l.etablissementId === etab.id)
      .map((l) => ({
        produit: l.produit.nom,
        numeroLot: l.numeroLot,
        datePeremption: l.datePeremption,
        quantite: l.quantite,
      })),
  }));

  return res.json(resultat);
}

// POST /stocks/entree
// Enregistre une réception externe (achat, don) directement dans le stock
// de l'établissement de l'utilisateur connecté — typiquement la CAMEC,
// point d'entrée des produits dans le système. Utilise creerOuIncrementerLot
// pour ne jamais créer de doublon si le numéro de lot existe déjà.
// Body : { produitId, numeroLot, datePeremption, quantite, dateReception?, fournisseur?, prixUnitaire?, note? }
async function entreeStock(req, res) {
  const { role } = req.utilisateur;
  let { etablissementId } = req.utilisateur;
  const { produitId, numeroLot, datePeremption, quantite, dateReception, fournisseur, prixUnitaire, note } = req.body;

  if (role === "ADMIN") {
    const camec = await prisma.etablissement.findFirst({ where: { type: "CAMEC" } });
    if (!camec) {
      return res.status(500).json({ erreur: "Aucun établissement CAMEC trouvé en base." });
    }
    etablissementId = camec.id;
  }

  const { utilisateurId } = req.utilisateur;

  if (!produitId || !numeroLot || !datePeremption || !quantite) {
    return res.status(400).json({ erreur: "Produit, numéro de lot, date de péremption et quantité sont requis." });
  }
  if (Number(quantite) <= 0) {
    return res.status(400).json({ erreur: "La quantité doit être positive." });
  }

  let lot;
  try {
    lot = await creerOuIncrementerLot({
      produitId,
      etablissementId,
      numeroLot,
      datePeremption: new Date(datePeremption),
      quantite: Number(quantite),
      fournisseur: fournisseur || undefined,
      prixUnitaire: prixUnitaire !== undefined && prixUnitaire !== "" ? Number(prixUnitaire) : undefined,
      note: note || undefined,
      dateReception: dateReception ? new Date(dateReception) : undefined,
    });
  } catch (erreur) {
    return res.status(409).json({ erreur: erreur.message });
  }

  const stockExistant = await prisma.stock.findUnique({
    where: { produitId_etablissementId: { produitId, etablissementId } },
  });

  if (stockExistant) {
    await prisma.stock.update({
      where: { produitId_etablissementId: { produitId, etablissementId } },
      data: { quantiteTotale: { increment: Number(quantite) } },
    });
  } else {
    const produit = await prisma.produit.findUnique({ where: { id: produitId } });
    await prisma.stock.create({
      data: {
        produitId,
        etablissementId,
        quantiteTotale: Number(quantite),
        seuilMin: produit?.seuilMinDefaut ?? 0,
        seuilMax: produit?.seuilMaxDefaut ?? 0,
        statut: "RUPTURE",
      },
    });
  }
  const stockMisAJour = await recalculerStatutStock(produitId, etablissementId);

  await prisma.mouvementStock.create({
    data: { lotId: lot.id, type: "ENTREE", quantite: Number(quantite), referenceType: "MANUEL", utilisateurId },
  });

  return res.status(201).json({ lot, stock: stockMisAJour });
}

// POST /stocks/dispensation
// Body : { produitId, quantite, typeBeneficiaire, beneficiaire }
// typeBeneficiaire : PATIENT | LABORATOIRE | MATERNITE | SERVICE
// beneficiaire : obligatoire (nom, téléphone ou code du bénéficiaire)
async function enregistrerDispensation(req, res) {
  const { etablissementId, utilisateurId, role } = req.utilisateur;
  if (role !== "FORMATION_SANITAIRE") {
    return res.status(403).json({ erreur: "Seule une formation sanitaire peut enregistrer une dispensation." });
  }

  const { produitId, quantite, typeBeneficiaire, beneficiaire } = req.body;
  if (!produitId || !quantite || Number(quantite) <= 0) {
    return res.status(400).json({ erreur: "Produit et quantité valide requis." });
  }

  const typesValides = ["PATIENT", "LABORATOIRE", "MATERNITE", "SERVICE"];
  if (!typeBeneficiaire || !typesValides.includes(typeBeneficiaire)) {
    return res.status(400).json({ erreur: "Type de bénéficiaire requis et invalide." });
  }
  if (!beneficiaire?.trim()) {
    return res.status(400).json({ erreur: "Le nom, téléphone ou code du bénéficiaire est requis." });
  }

  const { lotsChoisis, quantiteNonCouverte } = await selectionnerLotFEFO(produitId, etablissementId, Number(quantite));
  if (quantiteNonCouverte > 0) {
    return res.status(400).json({ erreur: `Stock insuffisant : ${quantiteNonCouverte} unité(s) manquante(s).` });
  }

  const dispensation = await prisma.dispensation.create({
    data: {
      etablissementId,
      produitId,
      quantite: Number(quantite),
      typeBeneficiaire,
      beneficiaire: beneficiaire.trim(),
      utilisateurId,
    },
  });

  for (const lotChoisi of lotsChoisis) {
    await prisma.lot.update({ where: { id: lotChoisi.lotId }, data: { quantite: { decrement: lotChoisi.quantite } } });
    await prisma.mouvementStock.create({
      data: {
        lotId: lotChoisi.lotId,
        type: "SORTIE",
        quantite: lotChoisi.quantite,
        referenceType: "DISPENSATION",
        referenceId: dispensation.id,
        utilisateurId,
      },
    });
  }

  await prisma.stock.update({
    where: { produitId_etablissementId: { produitId, etablissementId } },
    data: { quantiteTotale: { decrement: Number(quantite) } },
  });
  await recalculerStatutStock(produitId, etablissementId);

  return res.status(201).json({ message: "Dispensation enregistrée.", dispensation });
}

// GET /stocks/dispensation/rapport?dateDebut=YYYY-MM-DD&dateFin=YYYY-MM-DD
// Rapport complet des dispensations de la formation sanitaire connectée,
// sur une période ajustable dynamiquement (les deux dates sont optionnelles ;
// sans elles, tout l'historique est renvoyé). Chaque formation sanitaire ne
// voit que ses propres dispensations — c'est la contrepartie "lecture" de la
// traçabilité obligatoire mise en place à l'enregistrement.
//
// Le nom de l'établissement est renvoyé avec le rapport pour que le document
// exporté (PDF, image, impression) indique toujours de quelle formation
// sanitaire il provient — sans ça, un rapport imprimé ne se distingue pas
// d'un autre.
async function rapportDispensations(req, res) {
  const { etablissementId, role } = req.utilisateur;
  if (role !== "FORMATION_SANITAIRE") {
    return res.status(403).json({ erreur: "Seule une formation sanitaire peut consulter ce rapport." });
  }

  const { dateDebut, dateFin } = req.query;
  const filtreDate = {};
  if (dateDebut) filtreDate.gte = new Date(dateDebut);
  if (dateFin) {
    const fin = new Date(dateFin);
    fin.setHours(23, 59, 59, 999); // Inclut toute la journée de fin.
    filtreDate.lte = fin;
  }

  const etablissement = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    select: { nom: true },
  });

  const dispensations = await prisma.dispensation.findMany({
    where: {
      etablissementId,
      statut: "ACTIVE",
      ...(Object.keys(filtreDate).length > 0 ? { dateDispensation: filtreDate } : {}),
    },
    include: { produit: true, utilisateur: { select: { nomComplet: true } } },
    orderBy: { dateDispensation: "desc" },
  });

  const parType = {};
  const parProduit = {};
  let totalQuantite = 0;

  for (const d of dispensations) {
    totalQuantite += d.quantite;

    if (!parType[d.typeBeneficiaire]) parType[d.typeBeneficiaire] = { nombre: 0, quantite: 0 };
    parType[d.typeBeneficiaire].nombre += 1;
    parType[d.typeBeneficiaire].quantite += d.quantite;

    if (!parProduit[d.produit.nom]) parProduit[d.produit.nom] = 0;
    parProduit[d.produit.nom] += d.quantite;
  }

  return res.json({
    etablissement: etablissement?.nom || null,
    periode: { dateDebut: dateDebut || null, dateFin: dateFin || null },
    totalDispensations: dispensations.length,
    totalQuantite,
    parType: Object.entries(parType).map(([type, v]) => ({ type, ...v })),
    parProduit: Object.entries(parProduit)
      .map(([produit, quantite]) => ({ produit, quantite }))
      .sort((a, b) => b.quantite - a.quantite),
    lignes: dispensations.map((d) => ({
      id: d.id,
      date: d.dateDispensation,
      produit: d.produit.nom,
      quantite: d.quantite,
      typeBeneficiaire: d.typeBeneficiaire,
      beneficiaire: d.beneficiaire,
      enregistrePar: d.utilisateur?.nomComplet || null,
    })),
  });
}

// GET /stocks/cmm
async function calculerCmm(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  let filtreFs = null;
  let filtreProgrammeId = null;

  if (role === "FORMATION_SANITAIRE") {
    filtreFs = { id: etablissementId };
  } else if (role === "GAS_MOUGHATAA" || role === "MEDECIN_CHEF_MOUGHATAA") {
    filtreFs = { type: "FORMATION_SANITAIRE", moughataaId: etablissement.moughataaId };
  } else if (role === "GESTIONNAIRE_DRS") {
    filtreFs = { type: "FORMATION_SANITAIRE", drsId: etablissement.drsId };
  } else if (role === "GAS_PROGRAMME_NATIONAL") {
    filtreFs = { type: "FORMATION_SANITAIRE" };
    filtreProgrammeId = etablissement.programmeId;
  } else if (role === "GESTIONNAIRE_CAMEC" || role === "ADMIN") {
    filtreFs = { type: "FORMATION_SANITAIRE" };
  } else {
    return res.status(403).json({ erreur: "Le CMM n'est pas disponible pour ton rôle." });
  }

  const formationsSanitaires = await prisma.etablissement.findMany({ where: filtreFs });
  const fsIds = formationsSanitaires.map((f) => f.id);
  if (fsIds.length === 0) return res.json([]);

  const ilYA6Mois = new Date();
  ilYA6Mois.setMonth(ilYA6Mois.getMonth() - 6);

  const mouvements = await prisma.mouvementStock.findMany({
    where: {
      type: "SORTIE",
      referenceType: "DISPENSATION",
      dateMouvement: { gte: ilYA6Mois },
      lot: {
        etablissementId: { in: fsIds },
        ...(filtreProgrammeId ? { produit: { programmeId: filtreProgrammeId } } : {}),
      },
    },
    include: { lot: { include: { produit: true } } },
  });

  // Regroupement par produitId (pas par nom) — deux produits différents du
  // catalogue peuvent porter exactement le même nom ; les regrouper par nom
  // ferait fuiter le CMM de l'un vers l'autre. L'ID est la seule clé fiable,
  // le nom n'étant récupéré qu'à l'affichage.
  const totalParProduitId = {};
  const nomParProduitId = {};
  for (const m of mouvements) {
    const id = m.lot.produitId;
    totalParProduitId[id] = (totalParProduitId[id] || 0) + m.quantite;
    nomParProduitId[id] = m.lot.produit.nom;
  }

  const resultat = Object.entries(totalParProduitId).map(([produitId, total]) => ({
    produitId,
    produit: nomParProduitId[produitId],
    cmm: Math.round((total / 6) * 100) / 100,
  }));

  return res.json(resultat);
}

// GET /stocks/dmm-propre
async function dmmPropre(req, res) {
  const { etablissementId, role } = req.utilisateur;

  if (!["GAS_MOUGHATAA", "MEDECIN_CHEF_MOUGHATAA", "GESTIONNAIRE_DRS", "DIRECTEUR_DRS", "GESTIONNAIRE_CAMEC", "ADMIN"].includes(role)) {
    return res.status(403).json({ erreur: "Le DMM propre n'est pas disponible pour ton rôle." });
  }

  const dmmMap = await cmmParProduit(etablissementId, "BL");
  const produits = await prisma.produit.findMany();

  // produitId inclus explicitement : deux produits homonymes du catalogue ne
  // doivent jamais être confondus une fois reconvertis en nom pour l'affichage.
  const resultat = produits
    .filter((p) => dmmMap[p.id])
    .map((p) => ({ produitId: p.id, produit: p.nom, dmm: dmmMap[p.id] }));

  return res.json(resultat);
}

const N_MOIS_CIBLE = {
  FORMATION_SANITAIRE: 1,
  GAS_MOUGHATAA: 3,
  GAS_DRS: 6,
};

async function stockPhysiqueParProduit(etablissementId) {
  const stocks = await prisma.stock.findMany({ where: { etablissementId } });
  const map = {};
  for (const s of stocks) map[s.produitId] = s.quantiteTotale;
  return map;
}

function fusionner(cible, source) {
  for (const [produitId, quantite] of Object.entries(source)) {
    cible[produitId] = (cible[produitId] || 0) + quantite;
  }
  return cible;
}

async function stockDisponibleCumule(etablissement) {
  const total = await stockPhysiqueParProduit(etablissement.id);

  if (etablissement.type === "GAS_MOUGHATAA") {
    const formationsSanitaires = await prisma.etablissement.findMany({
      where: { type: "FORMATION_SANITAIRE", moughataaId: etablissement.moughataaId },
    });
    for (const fs of formationsSanitaires) {
      fusionner(total, await stockPhysiqueParProduit(fs.id));
    }
  }

  if (etablissement.type === "GAS_DRS") {
    const moughataas = await prisma.etablissement.findMany({
      where: { type: "GAS_MOUGHATAA", drsId: etablissement.drsId },
    });
    for (const m of moughataas) {
      fusionner(total, await stockDisponibleCumule(m));
    }
  }

  if (etablissement.type === "CAMEC") {
    const drsListe = await prisma.drs.findMany();
    for (const drs of drsListe) {
      const etabDrs = await prisma.etablissement.findFirst({ where: { type: "GAS_DRS", drsId: drs.id } });
      if (etabDrs) fusionner(total, await stockDisponibleCumule(etabDrs));
    }
  }

  return total;
}

async function cmmParProduit(etablissementId, referenceType) {
  const ilYA6Mois = new Date();
  ilYA6Mois.setMonth(ilYA6Mois.getMonth() - 6);

  const mouvements = await prisma.mouvementStock.findMany({
    where: {
      type: "SORTIE",
      referenceType,
      dateMouvement: { gte: ilYA6Mois },
      lot: { etablissementId },
    },
    include: { lot: true },
  });

  const totalParProduit = {};
  for (const m of mouvements) {
    totalParProduit[m.lot.produitId] = (totalParProduit[m.lot.produitId] || 0) + m.quantite;
  }

  const cmm = {};
  for (const [produitId, total] of Object.entries(totalParProduit)) {
    cmm[produitId] = Math.round((total / 6) * 100) / 100;
  }
  return cmm;
}

async function calculerCommandeSuggereePourEtablissement(etablissementId) {
  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
  if (!etablissement) throw new Error("Établissement introuvable.");

  const referenceType = etablissement.type === "FORMATION_SANITAIRE" ? "DISPENSATION" : "BL";
  const [cmm, disponible] = await Promise.all([
    cmmParProduit(etablissementId, referenceType),
    stockDisponibleCumule(etablissement),
  ]);

  const n = N_MOIS_CIBLE[etablissement.type] || 0;
  const produits = await prisma.produit.findMany();

  return produits.map((p) => {
    const cmmProduit = cmm[p.id] || 0;
    const stockDisponible = disponible[p.id] || 0;
    const cible = n * cmmProduit;
    const quantiteSuggeree = Math.max(0, Math.round(cible - stockDisponible));
    return {
      produitId: p.id,
      produit: p.nom,
      cmm: cmmProduit,
      stockDisponible,
      quantiteSuggeree,
    };
  });
}

// GET /stocks/commande-suggeree
async function commandeSuggeree(req, res) {
  const { etablissementId, role } = req.utilisateur;

  if (!["FORMATION_SANITAIRE", "GAS_MOUGHATAA", "GESTIONNAIRE_DRS", "GESTIONNAIRE_CAMEC", "ADMIN"].includes(role)) {
    return res.status(403).json({ erreur: "La commande suggérée n'est pas disponible pour ton rôle." });
  }

  try {
    const resultat = await calculerCommandeSuggereePourEtablissement(etablissementId);
    return res.json(resultat);
  } catch (erreur) {
    console.error("Erreur lors du calcul de la commande suggérée :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du calcul de la commande suggérée." });
  }
}

// GET /stocks/croisement?produitId=xxx&regroupement=moughataa|formationsanitaire
async function croisementStock(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { produitId, produitIds, regroupement } = req.query;

  const listeProduits = produitIds
    ? produitIds.split(",").map((p) => p.trim()).filter(Boolean)
    : produitId
    ? [produitId]
    : [];

  if (listeProduits.length === 0) {
    return res.status(400).json({ erreur: "Au moins un produit est requis." });
  }

  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  let etablissementsCibles = [];
  let regroupementsAutorises = [];

  if (role === "ADMIN") {
    etablissementsCibles = await prisma.etablissement.findMany({
      include: { drs: true, moughataa: { include: { drs: true } } },
    });
    regroupementsAutorises = ["drs", "moughataa", "formationsanitaire"];
  } else if (role === "GAS_PROGRAMME_NATIONAL") {
    const produitsChoisis = await prisma.produit.findMany({ where: { id: { in: listeProduits } } });
    const horsProgramme = produitsChoisis.find((p) => p.programmeId !== etablissement.programmeId);
    if (produitsChoisis.length !== listeProduits.length || horsProgramme) {
      return res.status(403).json({ erreur: "Un ou plusieurs produits sélectionnés n'appartiennent pas à ton programme." });
    }
    etablissementsCibles = await prisma.etablissement.findMany({
      where: { type: { in: ["GAS_DRS", "GAS_MOUGHATAA", "FORMATION_SANITAIRE"] } },
      include: { drs: true, moughataa: { include: { drs: true } } },
    });
    regroupementsAutorises = ["drs", "moughataa"];
  } else if (role === "GESTIONNAIRE_DRS" || role === "DIRECTEUR_DRS") {
    const moughataasRegion = await prisma.moughataa.findMany({
      where: { drsId: etablissement.drsId },
      select: { id: true },
    });
    const moughataaIds = moughataasRegion.map((m) => m.id);

    etablissementsCibles = await prisma.etablissement.findMany({
      where: {
        OR: [
          { id: etablissementId },
          { type: "GAS_MOUGHATAA", drsId: etablissement.drsId },
          { type: "FORMATION_SANITAIRE", moughataaId: { in: moughataaIds } },
        ],
      },
      include: { moughataa: true },
    });
    regroupementsAutorises = ["moughataa", "formationsanitaire"];
  } else if (role === "GAS_MOUGHATAA" || role === "MEDECIN_CHEF_MOUGHATAA") {
    etablissementsCibles = await prisma.etablissement.findMany({
      where: {
        OR: [
          { id: etablissementId },
          { type: "FORMATION_SANITAIRE", moughataaId: etablissement.moughataaId },
        ],
      },
    });
    regroupementsAutorises = ["formationsanitaire"];
  } else {
    return res.status(403).json({ erreur: "Cette vue n'est pas disponible pour ton rôle." });
  }

  const regroupementFinal = regroupementsAutorises.includes(regroupement)
    ? regroupement
    : regroupementsAutorises[0];

  const etablissementIds = etablissementsCibles.map((e) => e.id);
  const stocks = await prisma.stock.findMany({
    where: { etablissementId: { in: etablissementIds }, produitId: { in: listeProduits } },
  });

  function quantiteEtab(etabId) {
    return stocks.filter((s) => s.etablissementId === etabId).reduce((acc, s) => acc + s.quantiteTotale, 0);
  }

  let lignes;
  if (regroupementFinal === "drs") {
    const totaux = {};
    for (const etab of etablissementsCibles) {
      const quantite = quantiteEtab(etab.id);
      if (quantite === 0 && !stocks.some((s) => s.etablissementId === etab.id)) continue;
      const cle = etab.type === "GAS_DRS" ? etab.nom : etab.moughataa?.drs?.nom;
      if (!cle) continue;
      totaux[cle] = (totaux[cle] || 0) + quantite;
    }
    lignes = Object.entries(totaux).map(([nom, quantite]) => ({ nom, quantite }));
  } else if (regroupementFinal === "moughataa") {
    const totaux = {};
    for (const etab of etablissementsCibles) {
      const quantite = quantiteEtab(etab.id);
      if (quantite === 0 && !stocks.some((s) => s.etablissementId === etab.id)) continue;
      const cle = etab.moughataa?.nom;
      if (!cle) continue;
      totaux[cle] = (totaux[cle] || 0) + quantite;
    }
    lignes = Object.entries(totaux).map(([nom, quantite]) => ({ nom, quantite }));
  } else {
    lignes = etablissementsCibles.map((etab) => ({
      nom: etab.type === "GAS_MOUGHATAA" ? `Dépôt ${etab.nom}` : etab.nom,
      quantite: quantiteEtab(etab.id),
    }));
  }

  lignes.sort((a, b) => b.quantite - a.quantite);
  const total = lignes.reduce((acc, l) => acc + l.quantite, 0);

  return res.json({ regroupement: regroupementFinal, regroupementsDisponibles: regroupementsAutorises, lignes, total });
}

async function perimetreEtablissementIds(etablissementId, role) {
  if (role === "ADMIN" || role === "AUDITEUR") return null;

  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  if (role === "GESTIONNAIRE_CAMEC") {
    const etabs = await prisma.etablissement.findMany({
      where: { OR: [{ id: etablissementId }, { type: "GAS_DRS" }] },
      select: { id: true },
    });
    return etabs.map((e) => e.id);
  }

  if (role === "GAS_PROGRAMME_NATIONAL") {
    const etabs = await prisma.etablissement.findMany({ where: { type: "GAS_DRS" }, select: { id: true } });
    return etabs.map((e) => e.id);
  }

  if (role === "GESTIONNAIRE_DRS" || role === "DIRECTEUR_DRS") {
    const moughataasRegion = await prisma.moughataa.findMany({
      where: { drsId: etablissement.drsId },
      select: { id: true },
    });
    const moughataaIds = moughataasRegion.map((m) => m.id);
    const etabs = await prisma.etablissement.findMany({
      where: {
        OR: [
          { id: etablissementId },
          { type: "GAS_MOUGHATAA", drsId: etablissement.drsId },
          { type: "FORMATION_SANITAIRE", moughataaId: { in: moughataaIds } },
        ],
      },
      select: { id: true },
    });
    return etabs.map((e) => e.id);
  }

  if (role === "GAS_MOUGHATAA" || role === "MEDECIN_CHEF_MOUGHATAA") {
    const etabs = await prisma.etablissement.findMany({
      where: {
        OR: [{ id: etablissementId }, { type: "FORMATION_SANITAIRE", moughataaId: etablissement.moughataaId }],
      },
      select: { id: true },
    });
    return etabs.map((e) => e.id);
  }

  return [etablissementId];
}

// GET /stocks/performance-moughataa?produitId=xxx
async function performanceMoughataa(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { produitId } = req.query;
  const modeGlobal = !produitId;

  let moughataas;
  if (role === "ADMIN") {
    moughataas = await prisma.etablissement.findMany({
      where: { type: "GAS_MOUGHATAA" },
      include: { moughataa: true },
    });
  } else if (role === "GESTIONNAIRE_DRS" || role === "DIRECTEUR_DRS") {
    const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
    moughataas = await prisma.etablissement.findMany({
      where: { type: "GAS_MOUGHATAA", drsId: etablissement.drsId },
      include: { moughataa: true },
    });
  } else {
    return res.status(403).json({ erreur: "Cette vue n'est pas disponible pour ton rôle." });
  }

  function extraireValeur(map) {
    if (modeGlobal) return Object.values(map).reduce((acc, v) => acc + v, 0);
    return map[produitId] || 0;
  }

  const resultat = [];
  for (const m of moughataas) {
    const dmmMap = await cmmParProduit(m.id, "BL");
    const dmm = extraireValeur(dmmMap);

    const formationsSanitaires = await prisma.etablissement.findMany({
      where: { type: "FORMATION_SANITAIRE", moughataaId: m.moughataaId },
    });

    let sommeCmmFs = 0;
    for (const fs of formationsSanitaires) {
      const cmmFsMap = await cmmParProduit(fs.id, "DISPENSATION");
      sommeCmmFs += extraireValeur(cmmFsMap);
    }

    resultat.push({
      nom: m.moughataa?.nom || m.nom,
      dmm: Math.round(dmm * 100) / 100,
      sommeCmmFs: Math.round(sommeCmmFs * 100) / 100,
      ecart: Math.round((dmm - sommeCmmFs) * 100) / 100,
    });
  }

  resultat.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

  return res.json({ mode: modeGlobal ? "global" : "produit", lignes: resultat });
}

module.exports = {
  listerStocks,
  calculerStatut,
  selectionnerLotFEFO,
  stockReseau,
  entreeStock,
  enregistrerDispensation,
  rapportDispensations,
  calculerCmm,
  calculerCommandeSuggereePourEtablissement,
  commandeSuggeree,
  croisementStock,
  perimetreEtablissementIds,
  recalculerStatutStock,
  cmmParProduit,
  performanceMoughataa,
  creerOuIncrementerLot,
  dmmPropre,
};