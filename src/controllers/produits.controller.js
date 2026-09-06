const prisma = require("../config/prisma");

// GET /produits — catalogue complet, utilisé pour les sélecteurs dans les formulaires.
async function listerProduits(req, res) {
  const produits = await prisma.produit.findMany({ orderBy: { nom: "asc" } });
  return res.json(produits);
}

module.exports = { listerProduits };
