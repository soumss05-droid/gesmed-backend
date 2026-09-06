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

module.exports = { tableauDeBord, produitsEnRupture };
