const prisma = require("../config/prisma");

// Détermine le périmètre de données visible selon le rôle de l'utilisateur.
// AUDITEUR et ADMIN voient tout (vue nationale). Les autres rôles sont
// cloisonnés à leur propre établissement.
function construireFiltrePerimetre(utilisateur) {
  if (utilisateur.role === "AUDITEUR" || utilisateur.role === "ADMIN") {
    return {}; // pas de filtre = vue nationale
  }
  return { etablissementId: utilisateur.etablissementId };
}

// GET /rapports/tableau-de-bord
// KPIs de base, cloisonnés par périmètre.
async function tableauDeBord(req, res) {
  const filtre = construireFiltrePerimetre(req.utilisateur);

  const [stocks, requisitionsEnAttente, ecartsEnAttente] = await Promise.all([
    prisma.stock.findMany({ where: filtre, include: { produit: true } }),
    prisma.requisition.count({
      where: {
        statut: { in: ["EN_ATTENTE", "MODIFIEE_EN_ATTENTE_CONFIRMATION"] },
        ...(filtre.etablissementId ? { niveauActuelId: filtre.etablissementId } : {}),
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
      ...(filtre.etablissementId ? { etablissementId: filtre.etablissementId } : {}),
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
    ecartsEnAttente: req.utilisateur.role === "AUDITEUR" || req.utilisateur.role === "ADMIN" ? ecartsEnAttente : undefined,
  });
}

// GET /rapports/produits-en-rupture
// Classement des produits les plus souvent en rupture, cloisonné par périmètre.
async function produitsEnRupture(req, res) {
  const filtre = construireFiltrePerimetre(req.utilisateur);

  const stocksEnRupture = await prisma.stock.findMany({
    where: { ...filtre, statut: "RUPTURE" },
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

// GET /rapports/evolution-mouvements
// Agrège les mouvements de stock des 30 derniers jours, jour par jour,
// pour tracer une courbe entrées vs sorties. Cloisonné par périmètre comme
// le reste des rapports.
async function evolutionMouvements(req, res) {
  const filtre = construireFiltrePerimetre(req.utilisateur);

  const ilYA30Jours = new Date();
  ilYA30Jours.setDate(ilYA30Jours.getDate() - 30);

  const mouvements = await prisma.mouvementStock.findMany({
    where: {
      dateMouvement: { gte: ilYA30Jours },
      type: { in: ["ENTREE", "SORTIE"] },
      ...(filtre.etablissementId ? { lot: { etablissementId: filtre.etablissementId } } : {}),
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

// GET /rapports/requisitions-kanban
// Liste les réquisitions cloisonnées par périmètre, pour un affichage en
// tableau Kanban (une colonne par statut).
async function requisitionsKanban(req, res) {
  const { utilisateur } = req;
  const estVueNationale = utilisateur.role === "AUDITEUR" || utilisateur.role === "ADMIN";

  const requisitions = await prisma.requisition.findMany({
    where: estVueNationale
      ? {}
      : {
          OR: [
            { etablissementDemandeurId: utilisateur.etablissementId },
            { niveauActuelId: utilisateur.etablissementId },
          ],
        },
    include: {
      etablissementDemandeur: { select: { nom: true } },
      lignes: { include: { produit: { select: { nom: true } } } },
    },
    orderBy: { dateDerniereMaj: "desc" },
    take: 100,
  });

  return res.json(
    requisitions.map((r) => ({
      id: r.id,
      statut: r.statut,
      demandeur: r.etablissementDemandeur.nom,
      dateDerniereMaj: r.dateDerniereMaj,
      nbLignes: r.lignes.length,
      premierProduit: r.lignes[0]?.produit.nom || null,
    }))
  );
}

module.exports = { tableauDeBord, produitsEnRupture, evolutionMouvements, requisitionsKanban };