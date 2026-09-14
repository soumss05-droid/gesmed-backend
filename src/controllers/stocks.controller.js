const prisma = require("../config/prisma");

function calculerStatut(quantite, seuilMin, seuilMax) {
  if (quantite <= 0) return "RUPTURE";
  if (quantite < seuilMin) return "SOUS_SEUIL";
  if (quantite > seuilMax) return "SURSTOCK";
  return "NORMAL";
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

  let etablissementsCibles = [];

  if (role === "ADMIN") {
    etablissementsCibles = await prisma.etablissement.findMany({ orderBy: { nom: "asc" } });
  } else if (role === "GESTIONNAIRE_CAMEC") {
    etablissementsCibles = await prisma.etablissement.findMany({
      where: { OR: [{ id: etablissementId }, { type: "GAS_DRS" }] },
    });
  } else if (role === "GAS_PROGRAMME_NATIONAL") {
    etablissementsCibles = await prisma.etablissement.findMany({ where: { type: "GAS_DRS" } });
  } else if (role === "GESTIONNAIRE_DRS") {
    etablissementsCibles = await prisma.etablissement.findMany({
      where: { OR: [{ id: etablissementId }, { type: "GAS_MOUGHATAA", drsId: etablissement.drsId }] },
    });
  } else if (role === "GAS_MOUGHATAA") {
    etablissementsCibles = await prisma.etablissement.findMany({
      where: {
        OR: [
          { id: etablissementId },
          { type: "FORMATION_SANITAIRE", moughataaId: etablissement.moughataaId },
        ],
      },
    });
  } else {
    return res.status(403).json({ erreur: "Cette vue n'est pas disponible pour ton rôle." });
  }

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

  const resultat = etablissementsCibles.map((etab) => ({
    etablissementId: etab.id,
    etablissementNom: etab.nom,
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
// point d'entrée des produits dans le système.
// Body : { produitId, numeroLot, datePeremption, quantite }
async function entreeStock(req, res) {
  const { etablissementId, utilisateurId } = req.utilisateur;
  const { produitId, numeroLot, datePeremption, quantite } = req.body;

  if (!produitId || !numeroLot || !datePeremption || !quantite) {
    return res.status(400).json({ erreur: "Produit, numéro de lot, date de péremption et quantité sont requis." });
  }
  if (Number(quantite) <= 0) {
    return res.status(400).json({ erreur: "La quantité doit être positive." });
  }

  const lot = await prisma.lot.create({
    data: {
      produitId,
      etablissementId,
      numeroLot,
      datePeremption: new Date(datePeremption),
      quantite: Number(quantite),
    },
  });

  const stockExistant = await prisma.stock.findUnique({
    where: { produitId_etablissementId: { produitId, etablissementId } },
  });

  const stockMisAJour = stockExistant
    ? await prisma.stock.update({
        where: { produitId_etablissementId: { produitId, etablissementId } },
        data: { quantiteTotale: { increment: Number(quantite) } },
      })
    : await prisma.stock.create({
        data: { produitId, etablissementId, quantiteTotale: Number(quantite), seuilMin: 0, seuilMax: 0, statut: "NORMAL" },
      });

  await prisma.mouvementStock.create({
    data: { lotId: lot.id, type: "ENTREE", quantite: Number(quantite), referenceType: "MANUEL", utilisateurId },
  });

  return res.status(201).json({ lot, stock: stockMisAJour });
}

// POST /stocks/dispensation
// Enregistre la remise réelle d'un produit à un patient (uniquement au
// niveau formation sanitaire). Décrémente le stock en FEFO, comme une
// sortie classique, mais avec un referenceType distinct pour ne jamais
// être confondu avec une expédition (BL) vers un autre établissement.
async function enregistrerDispensation(req, res) {
  const { etablissementId, utilisateurId, role } = req.utilisateur;
  if (role !== "FORMATION_SANITAIRE") {
    return res.status(403).json({ erreur: "Seule une formation sanitaire peut enregistrer une dispensation." });
  }

  const { produitId, quantite } = req.body;
  if (!produitId || !quantite || Number(quantite) <= 0) {
    return res.status(400).json({ erreur: "Produit et quantité valide requis." });
  }

  const { lotsChoisis, quantiteNonCouverte } = await selectionnerLotFEFO(produitId, etablissementId, Number(quantite));
  if (quantiteNonCouverte > 0) {
    return res.status(400).json({ erreur: `Stock insuffisant : ${quantiteNonCouverte} unité(s) manquante(s).` });
  }

  for (const lotChoisi of lotsChoisis) {
    await prisma.lot.update({ where: { id: lotChoisi.lotId }, data: { quantite: { decrement: lotChoisi.quantite } } });
    await prisma.mouvementStock.create({
      data: { lotId: lotChoisi.lotId, type: "SORTIE", quantite: lotChoisi.quantite, referenceType: "DISPENSATION", utilisateurId },
    });
  }

  await prisma.stock.update({
    where: { produitId_etablissementId: { produitId, etablissementId } },
    data: { quantiteTotale: { decrement: Number(quantite) } },
  });

  return res.status(201).json({ message: "Dispensation enregistrée." });
}

// GET /stocks/cmm
// Calcule le CMM (Consommation Moyenne Mensuelle) sur les 6 derniers mois,
// à partir de la dispensation réelle des formations sanitaires. Pour un
// niveau intermédiaire (Moughataa, DRS, Programme, CAMEC/Admin), le CMM
// agrège la dispensation de toutes les formations sanitaires sous sa
// responsabilité.
async function calculerCmm(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  let filtreFs = null;
  let filtreProgrammeId = null;

  if (role === "FORMATION_SANITAIRE") {
    filtreFs = { id: etablissementId };
  } else if (role === "GAS_MOUGHATAA") {
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

  const totalParProduit = {};
  for (const m of mouvements) {
    const nom = m.lot.produit.nom;
    totalParProduit[nom] = (totalParProduit[nom] || 0) + m.quantite;
  }

  const resultat = Object.entries(totalParProduit).map(([produit, total]) => ({
    produit,
    cmm: Math.round((total / 6) * 100) / 100,
  }));

  return res.json(resultat);
}

module.exports = { listerStocks, calculerStatut, selectionnerLotFEFO, stockReseau, entreeStock, enregistrerDispensation, calculerCmm };