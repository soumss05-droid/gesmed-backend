const prisma = require("../config/prisma");

function calculerStatut(quantite, seuilMin, seuilMax) {
  if (quantite <= 0) return "RUPTURE";
  if (quantite < seuilMin) return "SOUS_SEUIL";
  if (quantite > seuilMax) return "SURSTOCK";
  return "NORMAL";
}

// Recalcule et enregistre le statut d'un stock à partir de sa quantité
// actuelle et de ses seuils — à appeler systématiquement après TOUT
// changement de quantiteTotale, pour que le statut ne reste jamais figé sur
// une ancienne valeur (ex. "RUPTURE" qui persiste après une rentrée).
//
// Pour une formation sanitaire uniquement, les seuils eux-mêmes sont aussi
// recalculés dynamiquement à partir de son propre CMM (0,5 mois pour le
// seuil min, 3 mois pour le seuil max) — bien plus pertinent que le seuil
// générique du produit, identique partout. Les autres niveaux (Moughataa,
// DRS, CAMEC) gardent leurs seuils actuels : ils disposent déjà d'outils
// plus fins (croisement, performance, commande suggérée). Tant qu'aucun
// historique de dispensation n'existe encore (CMM = 0), on garde les seuils
// par défaut du produit plutôt que 0/0, qui classerait à tort en "Surstock".
async function recalculerStatutStock(produitId, etablissementId) {
  const stock = await prisma.stock.findUnique({
    where: { produitId_etablissementId: { produitId, etablissementId } },
  });
  if (!stock) return null;

  let seuilMin = stock.seuilMin;
  let seuilMax = stock.seuilMax;

  const etablissement = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    select: { type: true },
  });

  if (etablissement?.type === "FORMATION_SANITAIRE") {
    const cmmMap = await cmmParProduit(etablissementId, "DISPENSATION");
    const cmm = cmmMap[produitId] || 0;
    if (cmm > 0) {
      seuilMin = Math.round(cmm * 0.5);
      seuilMax = Math.round(cmm * 3);
    } else {
      const produit = await prisma.produit.findUnique({
        where: { id: produitId },
        select: { seuilMinDefaut: true, seuilMaxDefaut: true },
      });
      seuilMin = produit?.seuilMinDefaut ?? stock.seuilMin;
      seuilMax = produit?.seuilMaxDefaut ?? stock.seuilMax;
    }
  }

  const statut = calculerStatut(stock.quantiteTotale, seuilMin, seuilMax);
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
async function creerOuIncrementerLot({ produitId, etablissementId, numeroLot, datePeremption, quantite }) {
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
    data: { produitId, etablissementId, numeroLot, datePeremption, quantite },
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

  // Vue CAMEC : cas particulier — chaque ligne représente une région
  // entière (dépôt DRS + tous ses Moughataa + toutes leurs formations
  // sanitaires, additionnés), pas seulement le dépôt DRS lui-même. C'est la
  // seule vue de cet écran qui agrège plusieurs établissements en une seule
  // ligne plutôt que d'en lister un par un — la CAMEC raisonne région par
  // région, pas établissement par établissement.
  if (role === "GESTIONNAIRE_CAMEC") {
    const toutesLesDrs = await prisma.drs.findMany({ orderBy: { nom: "asc" } });
    const resultatCamec = [];

    // Ligne 0 : le dépôt CAMEC lui-même, comme pour les autres rôles.
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

    // Une ligne par région : tous les établissements de la région
    // (dépôt DRS + Moughataa + FS) additionnés en un seul total par produit.
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
          statut: null, // Agrégat régional : pas de seuil unique applicable, pas de badge de statut.
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

  // Le dépôt du niveau consulté apparaît toujours en premier dans la liste,
  // avant les établissements qui en dépendent — plus lisible que l'ordre
  // arbitraire renvoyé par la base.
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

  // Nom d'affichage propre : "Moughataa Arafat" plutôt que "GAS Moughataa
  // Arafat" (le nom de l'établissement lui-même, qui peut différer du nom
  // de la Moughataa qu'il représente) ; le nom complet de la DRS pour un
  // GAS DRS (déjà au format "DRS Nouakchott Nord", pas besoin de préfixe).
  function nomAffichage(etab) {
    if (etab.type === "GAS_MOUGHATAA" && etab.moughataa?.nom) return `Moughataa ${etab.moughataa.nom}`;
    if (etab.type === "GAS_DRS" && etab.drs?.nom) return etab.drs.nom;
    return etab.nom;
  }

  // Clés de regroupement pour le filtrage en cascade côté frontend (région
  // puis Moughataa) — remonte via la Moughataa quand l'établissement n'a
  // pas de lien direct vers sa DRS (cas d'un GAS Moughataa ou d'une FS).
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
        statut: "RUPTURE", // recalculé juste en dessous, valeur de départ neutre
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
  await recalculerStatutStock(produitId, etablissementId);

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

// GET /stocks/dmm-propre
// DMM (Distribution Moyenne Mensuelle) propre à l'établissement connecté —
// ce que LUI a distribué vers le niveau en dessous (sorties de type BL
// depuis ses propres lots), sur les 6 derniers mois. Distinct de la CMM
// ci-dessus, qui mesure la consommation réelle des patients au niveau
// formation sanitaire : un GAS Moughataa ou un GAS DRS comptant son PROPRE
// dépôt en inventaire physique doit voir son propre rythme de distribution,
// pas la consommation de ses formations sanitaires. Réservé aux niveaux qui
// distribuent réellement depuis leur propre stock.
async function dmmPropre(req, res) {
  const { etablissementId, role } = req.utilisateur;

  if (!["GAS_MOUGHATAA", "MEDECIN_CHEF_MOUGHATAA", "GESTIONNAIRE_DRS", "DIRECTEUR_DRS", "GESTIONNAIRE_CAMEC", "ADMIN"].includes(role)) {
    return res.status(403).json({ erreur: "Le DMM propre n'est pas disponible pour ton rôle." });
  }

  const dmmMap = await cmmParProduit(etablissementId, "BL");
  const produits = await prisma.produit.findMany();

  const resultat = produits
    .filter((p) => dmmMap[p.id])
    .map((p) => ({ produit: p.nom, dmm: dmmMap[p.id] }));

  return res.json(resultat);
}

// ---------------------------------------------------------------------------
// Commande suggérée par niveau : CMM propre à chaque échelon + stock
// disponible cumulé sur son territoire réel (pas juste son dépôt).
//
// CMM :
//  - Formation sanitaire : dispensation réelle aux patients (SORTIE/DISPENSATION)
//  - GAS Moughataa, GAS DRS, CAMEC : leur propre distribution vers le niveau
//    juste en dessous (SORTIE/BL sortant de leurs propres lots)
//
// Stock disponible :
//  - Formation sanitaire : son stock physique propre
//  - GAS Moughataa : son stock physique + celui de ses formations sanitaires
//  - GAS DRS : son stock physique + stock cumulé de chaque Moughataa
//    (dépôt + ses FS)
//  - CAMEC : son stock physique + stock cumulé de chaque région (DRS)
//
// Quantité suggérée = (N × CMM) − stock disponible, jamais négative.
// N = 1 (formation sanitaire), 3 (GAS Moughataa), 6 (GAS DRS).
// ---------------------------------------------------------------------------

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

// Stock disponible cumulé sur tout le territoire réel de l'établissement
// (récursif : un GAS DRS cumule le stock physique de chaque Moughataa, qui
// lui-même cumule déjà le stock physique de ses formations sanitaires).
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

// CMM par produit, basé sur les sorties réelles de l'établissement lui-même
// (dispensation pour une formation sanitaire, distribution/BL pour les autres).
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

// Calcule, pour un établissement donné, le CMM, le stock disponible cumulé
// et la quantité suggérée à commander, produit par produit.
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
// Répartition d'un produit sur le périmètre du niveau consulté — région
// entière pour un GAS DRS/Directeur DRS (regroupée par Moughataa ou détaillée
// par formation sanitaire), ou Moughataa entière pour un GAS
// Moughataa/Médecin Chef de Moughataa (détaillée par formation sanitaire).
// Renvoie aussi le total, pour afficher le "stock total" du niveau.
async function croisementStock(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { produitId, produitIds, regroupement } = req.query;

  // Accepte soit un seul produitId (historique), soit plusieurs produitIds
  // séparés par des virgules — dans ce cas, les quantités des produits
  // sélectionnés sont additionnées par établissement avant regroupement.
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
    // Vue nationale, mais limitée aux produits de son propre programme.
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

  // Additionne les quantités de TOUS les produits sélectionnés pour un même
  // établissement — un établissement peut avoir jusqu'à listeProduits.length
  // lignes de stock désormais, une par produit choisi.
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
      // Toujours regrouper sous le nom de la Moughataa elle-même (jamais le
      // nom de l'établissement GAS Moughataa, qui peut différer) — sinon le
      // dépôt et ses formations sanitaires se retrouvent scindés en deux
      // lignes distinctes pour la même Moughataa.
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

// Liste des identifiants d'établissements du périmètre réel d'un
// utilisateur, selon son rôle — réutilisée à la fois pour le stock réseau et
// pour les rapports (évolution des mouvements), afin d'éviter deux logiques
// différentes qui finiraient par diverger. `null` signifie "pas de filtre"
// (vue nationale, réservée à ADMIN/AUDITEUR).
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

  // FORMATION_SANITAIRE et rôles non listés : uniquement son propre établissement.
  return [etablissementId];
}

// GET /stocks/performance-moughataa?produitId=xxx
// Indicateur de performance de gestion : compare, pour chaque Moughataa du
// périmètre, ce qu'elle a elle-même distribué (son DMM) à ce que ses
// formations sanitaires ont réellement consommé (la somme de leurs CMM). En
// théorie, bien gérés, ces deux chiffres convergent — un écart persistant
// signale soit un sous-approvisionnement chronique, soit un problème de
// dimensionnement. Réservé au GAS DRS/Directeur DRS (sa région) et à
// l'Admin (vue nationale).
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

  // Somme toutes les valeurs de la carte CMM (tous produits confondus) en
  // mode global, ou prend juste le produit choisi en mode détaillé.
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