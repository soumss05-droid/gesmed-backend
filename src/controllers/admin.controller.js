const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// GET /admin/drs — liste des 15 DRS (pour les menus déroulants)
async function listerDrs(req, res) {
  const drs = await prisma.drs.findMany({ orderBy: { nom: "asc" } });
  return res.json(drs);
}

// GET /admin/etablissements — liste de tous les établissements (pour les menus déroulants)
async function listerEtablissements(req, res) {
  const etablissements = await prisma.etablissement.findMany({
    include: { drs: true, moughataa: true },
    orderBy: { nom: "asc" },
  });
  return res.json(etablissements);
}

// POST /admin/moughataa
// Body : { nom, drsId }
async function creerMoughataa(req, res) {
  const { nom, drsId } = req.body;
  if (!nom || !drsId) {
    return res.status(400).json({ erreur: "Nom et DRS requis." });
  }
  const moughataa = await prisma.moughataa.create({ data: { nom, drsId } });
  return res.status(201).json(moughataa);
}

// POST /admin/etablissements
// Body : { nom, type, aStockPhysique, drsId?, moughataaId?, adresse? }
async function creerEtablissement(req, res) {
  const { nom, type, aStockPhysique, drsId, moughataaId, adresse } = req.body;

  if (!nom || !type) {
    return res.status(400).json({ erreur: "Nom et type requis." });
  }

  const etablissement = await prisma.etablissement.create({
    data: {
      nom,
      type,
      aStockPhysique: !!aStockPhysique,
      drsId: drsId || null,
      moughataaId: moughataaId || null,
      adresse: adresse || null,
    },
  });

  return res.status(201).json(etablissement);
}

// POST /admin/utilisateurs
// Body : { nomComplet, identifiant, motDePasse, telephone? }
async function creerUtilisateur(req, res) {
  const { nomComplet, identifiant, motDePasse, telephone } = req.body;

  if (!nomComplet || !identifiant || !motDePasse) {
    return res.status(400).json({ erreur: "Nom complet, identifiant et mot de passe requis." });
  }

  const motDePasseHash = await hashPassword(motDePasse);

  try {
    const utilisateur = await prisma.utilisateur.create({
      data: { nomComplet, identifiant, motDePasseHash, telephone: telephone || null },
    });
    return res.status(201).json({ id: utilisateur.id, nomComplet: utilisateur.nomComplet, identifiant: utilisateur.identifiant });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ erreur: "Cet identifiant est déjà utilisé." });
    }
    throw err;
  }
}

// POST /admin/utilisateurs/:id/rattachements
// Body : { etablissementId, role }
async function rattacherUtilisateur(req, res) {
  const { id } = req.params;
  const { etablissementId, role } = req.body;

  if (!etablissementId || !role) {
    return res.status(400).json({ erreur: "Établissement et rôle requis." });
  }

  try {
    const rattachement = await prisma.userEtablissement.create({
      data: { utilisateurId: id, etablissementId, role },
    });
    return res.status(201).json(rattachement);
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ erreur: "Cet utilisateur est déjà rattaché à cet établissement." });
    }
    throw err;
  }
}

// GET /admin/utilisateurs — liste des utilisateurs avec leurs rattachements
async function listerUtilisateurs(req, res) {
  const utilisateurs = await prisma.utilisateur.findMany({
    include: { etablissements: { include: { etablissement: true } } },
    orderBy: { nomComplet: "asc" },
  });
  return res.json(utilisateurs);
}

module.exports = {
  listerDrs,
  listerEtablissements,
  creerMoughataa,
  creerEtablissement,
  creerUtilisateur,
  rattacherUtilisateur,
  listerUtilisateurs,
};
