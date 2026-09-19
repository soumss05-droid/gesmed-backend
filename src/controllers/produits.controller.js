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
// Body : { nom, forme?, unite?, seuilMinDefaut, seuilMaxDefaut, programmeId }
// Réservé à la CAMEC et à l'Admin — ce sont eux qui introduisent les
// nouveaux produits dans le système, typiquement au moment d'une rentrée.
async function creerProduit(req, res) {
  const { nom, forme, unite, seuilMinDefaut, seuilMaxDefaut, programmeId } = req.body;

  if (!nom || !programmeId || seuilMinDefaut === undefined || seuilMaxDefaut === undefined) {
    return res.status(400).json({ erreur: "Nom, programme, seuil min et seuil max sont requis." });
  }

  const produit = await prisma.produit.create({
    data: {
      nom,
      forme: forme || null,
      unite: unite || null,
      seuilMinDefaut: Number(seuilMinDefaut),
      seuilMaxDefaut: Number(seuilMaxDefaut),
      programmeId,
    },
  });

  return res.status(201).json(produit);
}

module.exports = { listerProduits, listerProgrammesPourProduit, creerProduit };