const prisma = require("../config/prisma");

// GET /produits — catalogue complet, utilisé pour les sélecteurs dans les formulaires.
async function listerProduits(req, res) {
  const produits = await prisma.produit.findMany({ orderBy: { nom: "asc" } });
  return res.json(produits);
}

// GET /produits/programmes — liste des programmes, nécessaire pour créer un
// nouveau produit (chaque produit appartient à un programme). Accessible à
// tout utilisateur authentifié, pas seulement l'Admin, puisque la création
// d'un produit peut se faire directement depuis l'écran de rentrée CAMEC.
async function listerProgrammesPourProduit(req, res) {
  const programmes = await prisma.programme.findMany({ orderBy: { nom: "asc" } });
  return res.json(programmes);
}

// POST /produits
// Body : { nom, forme?, unite?, programmeId }
// Réservé à la CAMEC et à l'Admin — ce sont eux qui introduisent les
// nouveaux produits dans le système, typiquement au moment d'une rentrée.
//
// Les seuils min/max ne sont plus saisis à la création : ils démarrent à 0
// et seront calculés automatiquement à partir de la CMM/DMM une fois que
// le produit aura un historique de consommation dans le réseau (voir la
// fonction de recalcul des seuils dans stocks.controller.js).
async function creerProduit(req, res) {
  const { nom, forme, unite, programmeId } = req.body;

  if (!nom || !programmeId) {
    return res.status(400).json({ erreur: "Nom et programme sont requis." });
  }

  const produit = await prisma.produit.create({
    data: {
      nom,
      forme: forme || null,
      unite: unite || null,
      seuilMinDefaut: 0,
      seuilMaxDefaut: 0,
      programmeId,
    },
  });

  return res.status(201).json(produit);
}

module.exports = { listerProduits, listerProgrammesPourProduit, creerProduit };