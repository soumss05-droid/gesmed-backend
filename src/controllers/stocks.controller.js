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
        produit: stock.produit.nom,
        quantiteTotale: stock.quantiteTotale,
        seuilMin: stock.seuilMin,
        seuilMax: stock.seuilMax,
        statut: stock.statut,
        lots: lots.map((l) => ({
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

module.exports = { listerStocks, calculerStatut, selectionnerLotFEFO };
