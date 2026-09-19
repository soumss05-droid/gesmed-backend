const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// Rôles rattachables à un établissement (l'Admin système, lui, n'est pas un
// rôle de cette liste : c'est le booléen estAdminSysteme sur Utilisateur,
// indépendant de tout établissement).
const ROLES_DISPONIBLES = [
  "GESTIONNAIRE_CAMEC",
  "GESTIONNAIRE_DRS",
  "DIRECTEUR_DRS",
  "GAS_MOUGHATAA",
  "MEDECIN_CHEF_MOUGHATAA",
  "GAS_PROGRAMME_NATIONAL",
  "FORMATION_SANITAIRE",
  "AUDITEUR",
];

// GET /admin/drs — liste des DRS (pour les menus déroulants)
async function listerDrs(req, res) {
  const drs = await prisma.drs.findMany({ orderBy: { nom: "asc" } });
  return res.json(drs);
}

// POST /admin/drs
// Body : { nom, code }
async function creerDrs(req, res) {
  const { nom, code } = req.body;
  if (!nom || !code) {
    return res.status(400).json({ erreur: "Nom et code requis." });
  }
  try {
    const drs = await prisma.drs.create({ data: { nom, code } });
    return res.status(201).json(drs);
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ erreur: "Ce code de DRS est déjà utilisé." });
    }
    throw err;
  }
}

// GET /admin/programmes — liste des programmes (pour les menus déroulants,
// notamment pour créer un GAS Programme national ou un produit).
async function listerProgrammes(req, res) {
  const programmes = await prisma.programme.findMany({ orderBy: { nom: "asc" } });
  return res.json(programmes);
}

// GET /admin/roles — liste des rôles rattachables à un établissement.
async function listerRoles(req, res) {
  return res.json(ROLES_DISPONIBLES);
}

// GET /admin/etablissements — liste de tous les établissements (pour les menus déroulants)
async function listerEtablissements(req, res) {
  const etablissements = await prisma.etablissement.findMany({
    include: { drs: true, moughataa: true, programme: true },
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
// Body : { nom, type, aStockPhysique, drsId?, moughataaId?, programmeId?, adresse? }
// programmeId est pertinent uniquement pour un établissement de type
// GAS_PROGRAMME_NATIONAL (chaque GAS Programme national gère un seul programme).
async function creerEtablissement(req, res) {
  const { nom, type, aStockPhysique, drsId, moughataaId, programmeId, adresse } = req.body;

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
      programmeId: programmeId || null,
      adresse: adresse || null,
    },
  });

  return res.status(201).json(etablissement);
}

// PATCH /admin/etablissements/:id
// Body : n'importe quel sous-ensemble des mêmes champs que la création, pour
// corriger une fiche existante (ex. rattacher un DRS oublié à la création).
async function modifierEtablissement(req, res) {
  const { id } = req.params;
  const { nom, type, aStockPhysique, drsId, moughataaId, programmeId, adresse, actif } = req.body;

  const donnees = {};
  if (nom !== undefined) donnees.nom = nom;
  if (type !== undefined) donnees.type = type;
  if (aStockPhysique !== undefined) donnees.aStockPhysique = !!aStockPhysique;
  if (drsId !== undefined) donnees.drsId = drsId || null;
  if (moughataaId !== undefined) donnees.moughataaId = moughataaId || null;
  if (programmeId !== undefined) donnees.programmeId = programmeId || null;
  if (adresse !== undefined) donnees.adresse = adresse || null;
  if (actif !== undefined) donnees.actif = !!actif;

  try {
    const etablissement = await prisma.etablissement.update({ where: { id }, data: donnees });
    return res.json(etablissement);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ erreur: "Établissement introuvable." });
    }
    throw err;
  }
}

// POST /admin/utilisateurs
// Body : { nomComplet, identifiant, motDePasse, telephone?, estAdminSysteme? }
async function creerUtilisateur(req, res) {
  const { nomComplet, identifiant, motDePasse, telephone, estAdminSysteme } = req.body;

  if (!nomComplet || !identifiant || !motDePasse) {
    return res.status(400).json({ erreur: "Nom complet, identifiant et mot de passe requis." });
  }

  const motDePasseHash = await hashPassword(motDePasse);

  try {
    const utilisateur = await prisma.utilisateur.create({
      data: {
        nomComplet,
        identifiant,
        motDePasseHash,
        telephone: telephone || null,
        estAdminSysteme: !!estAdminSysteme,
      },
    });
    return res.status(201).json({
      id: utilisateur.id,
      nomComplet: utilisateur.nomComplet,
      identifiant: utilisateur.identifiant,
      estAdminSysteme: utilisateur.estAdminSysteme,
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ erreur: "Cet identifiant est déjà utilisé." });
    }
    throw err;
  }
}

// PATCH /admin/utilisateurs/:id
// Body : n'importe quel sous-ensemble de { nomComplet, telephone, actif,
// estAdminSysteme, motDePasse }. motDePasse, s'il est fourni, réinitialise
// le mot de passe (ré-haché) — sinon inchangé.
async function modifierUtilisateur(req, res) {
  const { id } = req.params;
  const { nomComplet, telephone, actif, estAdminSysteme, motDePasse } = req.body;

  const donnees = {};
  if (nomComplet !== undefined) donnees.nomComplet = nomComplet;
  if (telephone !== undefined) donnees.telephone = telephone || null;
  if (actif !== undefined) donnees.actif = !!actif;
  if (estAdminSysteme !== undefined) donnees.estAdminSysteme = !!estAdminSysteme;
  if (motDePasse) donnees.motDePasseHash = await hashPassword(motDePasse);

  try {
    const utilisateur = await prisma.utilisateur.update({ where: { id }, data: donnees });
    return res.json({
      id: utilisateur.id,
      nomComplet: utilisateur.nomComplet,
      identifiant: utilisateur.identifiant,
      actif: utilisateur.actif,
      estAdminSysteme: utilisateur.estAdminSysteme,
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ erreur: "Utilisateur introuvable." });
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
  if (!ROLES_DISPONIBLES.includes(role)) {
    return res.status(400).json({ erreur: `Rôle inconnu. Valeurs possibles : ${ROLES_DISPONIBLES.join(", ")}.` });
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

// DELETE /admin/utilisateurs/:id/rattachements/:rattachementId
// Retire un rattachement (ex. l'utilisateur change de poste). Ne supprime
// jamais le compte lui-même, juste ce lien établissement/rôle précis.
async function retirerRattachement(req, res) {
  const { rattachementId } = req.params;

  try {
    await prisma.userEtablissement.delete({ where: { id: rattachementId } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ erreur: "Rattachement introuvable." });
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

// GET /admin/notifications — vue nationale de toutes les notifications,
// tous établissements confondus, avec le destinataire et l'auteur visibles.
// Seul l'Admin système, non rattaché à un établissement précis, a besoin de
// cette vue globale (les autres rôles consultent /notifications, limitée à
// leur propre établissement).
async function listerToutesNotifications(req, res) {
  const notifications = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      etablissement: { select: { nom: true } },
      etablissementAuteur: { select: { nom: true } },
      requisition: { select: { id: true, statut: true } },
      produit: { select: { id: true, nom: true } },
    },
    take: 200,
  });
  return res.json(notifications);
}

// GET /admin/moughataa — liste des Moughataa (pour les menus déroulants)
async function listerMoughataa(req, res) {
  const moughataas = await prisma.moughataa.findMany({
    include: { drs: { select: { nom: true } } },
    orderBy: { nom: "asc" },
  });
  return res.json(moughataas);
}

// GET /admin/stocks — vue nationale de tous les lots en stock (quantité >
// 0), tous établissements confondus, pour permettre à l'Admin de filtrer
// par produit, par date de péremption, ou par niveau (type d'établissement).
async function listerTousLesLots(req, res) {
  const lots = await prisma.lot.findMany({
    where: { quantite: { gt: 0 } },
    include: {
      produit: { select: { id: true, nom: true } },
      etablissement: { select: { id: true, nom: true, type: true } },
    },
    orderBy: { datePeremption: "asc" },
  });
  return res.json(lots);
}

// DELETE /admin/drs/:id
// Supprime une DRS uniquement si aucun établissement ni Moughataa n'y est
// rattaché — sinon la contrainte de clé étrangère de la base l'empêchera de
// toute façon, mais on donne un message clair plutôt qu'une erreur brute.
async function supprimerDrs(req, res) {
  const { id } = req.params;

  try {
    await prisma.drs.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ erreur: "DRS introuvable." });
    }
    if (err.code === "P2003") {
      return res.status(409).json({
        erreur: "Impossible de supprimer cette DRS : des établissements ou Moughataa y sont encore rattachés.",
      });
    }
    throw err;
  }
}

module.exports = {
  listerDrs,
  creerDrs,
  listerProgrammes,
  listerRoles,
  listerEtablissements,
  creerMoughataa,
  creerEtablissement,
  modifierEtablissement,
  creerUtilisateur,
  modifierUtilisateur,
  rattacherUtilisateur,
  retirerRattachement,
  listerUtilisateurs,
  listerToutesNotifications,
  listerMoughataa,
  listerTousLesLots,
  supprimerDrs,
};