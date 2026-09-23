const prisma = require("../config/prisma");
const { perimetreEtablissementIds } = require("./stocks.controller");

// GET /rapports/tableau-de-bord
// KPIs de base. Le stock (références, ruptures, sous seuil, lots périmés)
// couvre tout le périmètre réel du rôle (région pour un GAS DRS, Moughataa
// pour un GAS Moughataa/Médecin Chef de Moughataa) — la file de réquisitions
// en attente, elle, reste volontairement limitée à SON PROPRE niveau (ce
// que l'utilisateur doit lui-même traiter, pas toute sa zone).
async function tableauDeBord(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const etablissementIds = await perimetreEtablissementIds(etablissementId, role);
  const filtreStock = etablissementIds ? { etablissementId: { in: etablissementIds } } : {};

  const [stocks, requisitionsEnAttente, ecartsEnAttente] = await Promise.all([
    prisma.stock.findMany({ where: filtreStock, include: { produit: true } }),
    prisma.requisition.count({
      where: {
        statut: { in: ["EN_ATTENTE", "MODIFIEE_EN_ATTENTE_CONFIRMATION"] },
        ...(role !== "AUDITEUR" && role !== "ADMIN" ? { niveauActuelId: etablissementId } : {}),
      },
    }),
    prisma.blLigne.count({ where: { ecartStatut: "EN_ATTENTE" } }),
  ]);

  const ruptures = stocks.filter((s) => s.statut === "RUPTURE").length;
  const sousSeuil = stocks.filter((s) => s.statut === "SOUS_SEUIL").length;

  const dansTroisMois = new Date();
  dansTroisMois.setMonth(dansTroisMois.getMonth() + 3);

  const lotsBientotPerimes = await prisma.lot.count({
    where: {
      ...(etablissementIds ? { etablissementId: { in: etablissementIds } } : {}),
      quantite: { gt: 0 },
      datePeremption: { lte: dansTroisMois },
    },
  });

  return res.json({
    referencesEnStock: stocks.length,
    ruptures,
    sousSeuil,
    lotsBientotPerimes,
    requisitionsEnAttente,
    ecartsEnAttente: role === "AUDITEUR" || role === "ADMIN" ? ecartsEnAttente : undefined,
  });
}

// GET /rapports/produits-en-rupture
// Classement des produits les plus souvent en rupture, sur tout le périmètre
// réel du rôle (même logique que le tableau de bord ci-dessus).
async function produitsEnRupture(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const etablissementIds = await perimetreEtablissementIds(etablissementId, role);
  const filtreStock = etablissementIds ? { etablissementId: { in: etablissementIds } } : {};

  const stocksEnRupture = await prisma.stock.findMany({
    where: { ...filtreStock, statut: "RUPTURE" },
    include: { produit: true, etablissement: true },
  });

  const parProduit = {};
  for (const s of stocksEnRupture) {
    if (!parProduit[s.produit.nom]) {
      parProduit[s.produit.nom] = { produit: s.produit.nom, structuresTouchees: 0 };
    }
    parProduit[s.produit.nom].structuresTouchees += 1;
  }

  return res.json(Object.values(parProduit).sort((a, b) => b.structuresTouchees - a.structuresTouchees));
}

// GET /rapports/evolution-mouvements?dateDebut=YYYY-MM-DD&dateFin=YYYY-MM-DD
// Agrège les mouvements de stock jour par jour, pour tracer une courbe
// entrées vs sorties, sur la période choisie par l'utilisateur (30 derniers
// jours par défaut si aucune date n'est fournie, pour ne rien casser côté
// écrans qui n'ont pas encore de sélecteur de dates). Utilise le vrai
// périmètre du rôle (région entière pour un GAS DRS, Moughataa entière pour
// un GAS Moughataa/Médecin Chef de Moughataa — pas seulement le dépôt
// propre), via la même logique que le croisement de stocks.
async function evolutionMouvements(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { dateDebut, dateFin } = req.query;
  const etablissementIds = await perimetreEtablissementIds(etablissementId, role);

  const debut = dateDebut ? new Date(dateDebut) : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  })();
  const fin = dateFin ? new Date(dateFin + "T23:59:59") : new Date();

  const mouvements = await prisma.mouvementStock.findMany({
    where: {
      dateMouvement: { gte: debut, lte: fin },
      type: { in: ["ENTREE", "SORTIE"] },
      ...(etablissementIds ? { lot: { etablissementId: { in: etablissementIds } } } : {}),
    },
    select: { type: true, quantite: true, dateMouvement: true },
  });

  const parJour = {};
  for (const m of mouvements) {
    const jour = m.dateMouvement.toISOString().slice(0, 10);
    if (!parJour[jour]) parJour[jour] = { date: jour, entrees: 0, sorties: 0 };
    if (m.type === "ENTREE") parJour[jour].entrees += m.quantite;
    else parJour[jour].sorties += m.quantite;
  }

  const resultat = Object.values(parJour).sort((a, b) => a.date.localeCompare(b.date));
  return res.json(resultat);
}

// GET /rapports/mouvements-detailles?dateDebut=X&dateFin=Y&niveau=CAMEC|GAS_DRS|GAS_MOUGHATAA|FORMATION_SANITAIRE|GAS_PROGRAMME_NATIONAL
// Détail ligne par ligne des entrées, sorties et péremptions sur une
// période choisie — base commune du rapport Excel "Mouvements" et des KPI
// CAMEC (combien livré, combien périmé). Toujours cloisonné au périmètre
// réel du rôle ; le paramètre "niveau" restreint encore ce périmètre à un
// seul type d'établissement, sans jamais en sortir.
async function mouvementsDetailles(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { dateDebut, dateFin, niveau } = req.query;

  if (!dateDebut || !dateFin) {
    return res.status(400).json({ erreur: "dateDebut et dateFin sont requis." });
  }

  const debut = new Date(dateDebut);
  const fin = new Date(dateFin + "T23:59:59");

  const perimetre = await perimetreEtablissementIds(etablissementId, role);

  let etablissementIdsFinal = perimetre;
  if (niveau) {
    const etabsNiveau = await prisma.etablissement.findMany({
      where: { type: niveau, ...(perimetre ? { id: { in: perimetre } } : {}) },
      select: { id: true },
    });
    etablissementIdsFinal = etabsNiveau.map((e) => e.id);
  }

  const filtreEtab = etablissementIdsFinal ? { etablissementId: { in: etablissementIdsFinal } } : {};

  const mouvements = await prisma.mouvementStock.findMany({
    where: {
      dateMouvement: { gte: debut, lte: fin },
      type: { in: ["ENTREE", "SORTIE"] },
      lot: filtreEtab,
    },
    include: {
      lot: { include: { produit: { select: { nom: true } }, etablissement: { select: { nom: true, type: true } } } },
    },
    orderBy: { dateMouvement: "asc" },
  });

  function formaterLigne(m) {
    return {
      produit: m.lot.produit.nom,
      numeroLot: m.lot.numeroLot,
      quantite: m.quantite,
      etablissement: m.lot.etablissement.nom,
      referenceType: m.referenceType,
      date: m.dateMouvement,
    };
  }

  const entrees = mouvements.filter((m) => m.type === "ENTREE").map(formaterLigne);
  const sorties = mouvements.filter((m) => m.type === "SORTIE").map(formaterLigne);

  const lotsPerimesPeriode = await prisma.lot.findMany({
    where: {
      ...filtreEtab,
      datePeremption: { gte: debut, lte: fin },
    },
    include: { produit: { select: { nom: true } }, etablissement: { select: { nom: true } } },
  });
  const perimes = lotsPerimesPeriode.map((l) => ({
    produit: l.produit.nom,
    numeroLot: l.numeroLot,
    quantite: l.quantite,
    etablissement: l.etablissement.nom,
    datePeremption: l.datePeremption,
  }));

  return res.json({ entrees, sorties, perimes });
}

// GET /rapports/requisitions-kanban
// Liste les réquisitions cloisonnées par périmètre, pour un affichage en
// tableau Kanban (une colonne par statut).
//
// Cas particulier CAMEC : le périmètre habituel (demandeur ou niveau actuel
// = son propre établissement) ne montrerait que les réquisitions DÉJÀ
// arrivées à son niveau — trop tard pour anticiper. La CAMEC voit donc en
// plus, dès leur création et quel que soit leur niveau actuel : (1) les
// commandes de réapprovisionnement propres à chaque GAS DRS (la seule voie
// légitime vers CAMEC hors exception), et (2) toutes les réquisitions des
// établissements en approvisionnement direct CAMEC (Moughataa ou FS en
// exception géographique), qui la concernent de bout en bout même avant
// d'avoir atteint son niveau.
async function requisitionsKanban(req, res) {
  const { utilisateur } = req;
  const estVueNationale = utilisateur.role === "AUDITEUR" || utilisateur.role === "ADMIN";
  const estCamec = utilisateur.role === "GESTIONNAIRE_CAMEC";

  const filtrePerimetre = estVueNationale
    ? {}
    : estCamec
    ? {
        OR: [
          { etablissementDemandeurId: utilisateur.etablissementId },
          { niveauActuelId: utilisateur.etablissementId },
          { etablissementDemandeur: { type: "GAS_DRS" } },
          { etablissementDemandeur: { approvisionnementDirectCamec: true } },
        ],
      }
    : {
        OR: [
          { etablissementDemandeurId: utilisateur.etablissementId },
          { niveauActuelId: utilisateur.etablissementId },
        ],
      };

  const requisitions = await prisma.requisition.findMany({
    where: filtrePerimetre,
    include: {
      etablissementDemandeur: { select: { nom: true } },
      niveauActuel: { select: { nom: true } },
      lignes: { include: { produit: { select: { nom: true } } } },
    },
    orderBy: { dateDerniereMaj: "desc" },
    take: 100,
  });

  return res.json(
    requisitions.map((r) => ({
      id: r.id,
      numero: r.numero,
      statut: r.statut,
      demandeur: r.etablissementDemandeur.nom,
      niveauActuel: r.niveauActuel?.nom || null,
      dateDerniereMaj: r.dateDerniereMaj,
      nbLignes: r.lignes.length,
      premierProduit: r.lignes[0]?.produit.nom || null,
    }))
  );
}

module.exports = { tableauDeBord, produitsEnRupture, evolutionMouvements, requisitionsKanban, mouvementsDetailles };