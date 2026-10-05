const prisma = require("../config/prisma");

// Rôles autorisés à poser un verrou "pour leur zone", et le type
// d'établissement qu'ils verrouillent en cascade, avec le périmètre
// géographique à utiliser pour retrouver les cibles. ADMIN n'est pas dans
// cette table : il verrouille n'importe quel établissement individuellement
// via verrouillerEtablissement, pas via verrouillerMaZone.
const CASCADE = {
  GAS_MOUGHATAA: { typeCible: "FORMATION_SANITAIRE", scope: "moughataa" },
  GESTIONNAIRE_DRS: { typeCible: "GAS_MOUGHATAA", scope: "drs" },
  DIRECTEUR_DRS: { typeCible: "GAS_MOUGHATAA", scope: "drs" },
  GAS_PROGRAMME_NATIONAL: { typeCible: "GAS_DRS", scope: "national" },
};

// Détermine le périmètre géographique (liste des établissements cibles) et le
// programmeId à appliquer au verrou, à partir du rôle de l'utilisateur
// connecté et de son propre établissement. Pour GAS_PROGRAMME_NATIONAL, le
// programmeId est TOUJOURS dérivé côté serveur depuis le programme de son
// propre établissement : il n'est jamais fourni par le client, pour éviter
// qu'un GAS d'un programme ne verrouille les produits d'un autre programme.
async function determinerPerimetreZone(role, moi) {
  const regle = CASCADE[role];
  if (!regle) return null;

  let where = { type: regle.typeCible };
  let programmeId = null;

  if (regle.scope === "moughataa") {
    if (!moi.moughataaId) return { erreur: "Ton établissement n'est rattaché à aucune moughataa." };
    where.moughataaId = moi.moughataaId;
  } else if (regle.scope === "drs") {
    if (!moi.drsId) return { erreur: "Ton établissement n'est rattaché à aucune DRS." };
    where.drsId = moi.drsId;
  } else if (regle.scope === "national") {
    if (!moi.programmeId) {
      return { erreur: "Ton établissement n'est rattaché à aucun programme : impossible de déterminer le périmètre du verrou." };
    }
    programmeId = moi.programmeId;
    // Pas de filtre géographique supplémentaire : le verrou s'applique à tous
    // les GAS_DRS du pays, mais seulement pour ce programme précis.
  }

  const etablissements = await prisma.etablissement.findMany({ where });
  return { etablissements, programmeId };
}

// GET /verrouillage/ma-zone
// Vue en lecture seule pour l'utilisateur connecté (GAS_MOUGHATAA,
// GESTIONNAIRE_DRS, DIRECTEUR_DRS, GAS_PROGRAMME_NATIONAL) : montre l'état de
// verrouillage des établissements de son périmètre AVANT d'agir, pour
// afficher correctement le bouton "Verrouiller ma zone" côté frontend.
async function etatMaZone(req, res) {
  const { etablissementId, role } = req.utilisateur;

  if (!etablissementId) {
    return res.status(403).json({
      erreur: "Cet utilisateur n'est rattaché à aucun établissement et n'a pas de zone à consulter.",
    });
  }

  const regle = CASCADE[role];
  if (!regle) {
    return res.status(403).json({
      erreur: "Ton rôle ne permet pas de consulter un périmètre de verrouillage. Seuls GAS_MOUGHATAA, GESTIONNAIRE_DRS, DIRECTEUR_DRS et GAS_PROGRAMME_NATIONAL le peuvent.",
    });
  }

  const moi = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
  if (!moi) {
    return res.status(404).json({ erreur: "Établissement introuvable." });
  }

  const perimetre = await determinerPerimetreZone(role, moi);
  if (perimetre.erreur) {
    return res.status(400).json({ erreur: perimetre.erreur });
  }

  const { etablissements, programmeId } = perimetre;
  if (etablissements.length === 0) {
    return res.json({ programmeConcerne: null, etablissements: [] });
  }

  const verrous = await prisma.verrouSaisieInitiale.findMany({
    where: {
      etablissementId: { in: etablissements.map((e) => e.id) },
      OR: [{ programmeId: null }, { programmeId }],
    },
  });
  const verrouilles = new Set(verrous.map((v) => v.etablissementId));

  let programmeConcerne = null;
  if (programmeId) {
    const programme = await prisma.programme.findUnique({ where: { id: programmeId }, select: { id: true, nom: true } });
    programmeConcerne = programme || null;
  }

  return res.json({
    programmeConcerne,
    etablissements: etablissements.map((e) => ({
      id: e.id,
      nom: e.nom,
      verrouille: verrouilles.has(e.id),
    })),
  });
}

// POST /verrouillage/ma-zone
// Verrouille la saisie initiale (/stocks/entree) pour les établissements du
// périmètre direct de l'utilisateur connecté, selon son rôle :
//   - GAS_MOUGHATAA          -> verrouille les FORMATION_SANITAIRE de sa moughataa (total)
//   - GESTIONNAIRE_DRS /
//     DIRECTEUR_DRS          -> verrouille les GAS_MOUGHATAA de sa DRS (total)
//   - GAS_PROGRAMME_NATIONAL -> verrouille les GAS_DRS, mais seulement pour
//     son propre programme (les autres programmes restent libres à ce GAS_DRS)
// CAMEC n'est jamais une cible : c'est le point d'entrée officiel, toujours libre.
async function verrouillerMaZone(req, res) {
  const { utilisateurId, etablissementId, role } = req.utilisateur;

  if (!etablissementId) {
    return res.status(403).json({
      erreur: "Cet utilisateur n'est rattaché à aucun établissement et ne peut verrouiller aucune zone.",
    });
  }

  const regle = CASCADE[role];
  if (!regle) {
    return res.status(403).json({
      erreur: "Ton rôle ne permet pas de verrouiller une zone. Seuls GAS_MOUGHATAA, GESTIONNAIRE_DRS, DIRECTEUR_DRS et GAS_PROGRAMME_NATIONAL le peuvent.",
    });
  }

  const moi = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
  if (!moi) {
    return res.status(404).json({ erreur: "Établissement introuvable." });
  }

  const perimetre = await determinerPerimetreZone(role, moi);
  if (perimetre.erreur) {
    return res.status(400).json({ erreur: perimetre.erreur });
  }

  const { etablissements: cibles, programmeId } = perimetre;
  if (cibles.length === 0) {
    return res.status(404).json({ erreur: "Aucun établissement trouvé dans ton périmètre pour ce verrou." });
  }

  // Dédoublonnage applicatif : pas de @@unique en base (programmeId nullable
  // rend l'unicité Postgres inopérante sur les lignes NULL), donc on vérifie
  // ici qu'aucun verrou identique (même établissement + même programmeId, y
  // compris les deux null) n'existe déjà avant de le créer.
  const verrousExistants = await prisma.verrouSaisieInitiale.findMany({
    where: { etablissementId: { in: cibles.map((c) => c.id) }, programmeId },
  });
  const dejaVerrouilles = new Set(verrousExistants.map((v) => v.etablissementId));
  const aCreer = cibles.filter((c) => !dejaVerrouilles.has(c.id));

  if (aCreer.length > 0) {
    await prisma.verrouSaisieInitiale.createMany({
      data: aCreer.map((c) => ({
        etablissementId: c.id,
        programmeId,
        poseParId: utilisateurId,
      })),
    });
  }

  return res.status(201).json({
    message: `${aCreer.length} établissement(s) verrouillé(s) (${verrousExistants.length} déjà verrouillé(s) ignoré(s)).`,
    etablissementsVerrouilles: aCreer.map((c) => ({ id: c.id, nom: c.nom })),
  });
}

// POST /verrouillage/etablissements/:etablissementId
// Réservé à ADMIN. Verrou total (programmeId null) sur un établissement précis,
// quel que soit son type (sauf CAMEC, toujours libre).
async function verrouillerEtablissement(req, res) {
  const { utilisateurId, role } = req.utilisateur;
  const { etablissementId } = req.params;

  if (role !== "ADMIN") {
    return res.status(403).json({ erreur: "Seul l'administrateur peut verrouiller un établissement individuellement." });
  }

  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
  if (!etablissement) {
    return res.status(404).json({ erreur: "Établissement introuvable." });
  }
  if (etablissement.type === "CAMEC") {
    return res.status(400).json({ erreur: "La CAMEC est le point d'entrée officiel du circuit : elle ne peut pas être verrouillée." });
  }

  const existant = await prisma.verrouSaisieInitiale.findFirst({
    where: { etablissementId, programmeId: null },
  });
  if (existant) {
    return res.status(409).json({ erreur: "Cet établissement est déjà sous verrou total." });
  }

  const verrou = await prisma.verrouSaisieInitiale.create({
    data: { etablissementId, programmeId: null, poseParId: utilisateurId },
  });

  return res.status(201).json({ message: "Établissement verrouillé.", verrou });
}

// DELETE /verrouillage/etablissements/:etablissementId
// Réservé à ADMIN, sans exception : quel que soit le rôle qui a posé le
// verrou à l'origine (Moughataa, DRS, Programme National ou Admin lui-même),
// seul Admin peut déverrouiller. Supprime TOUS les verrous (total + tous les
// verrous de programme) de cet établissement.
async function deverrouillerEtablissement(req, res) {
  const { role } = req.utilisateur;
  const { etablissementId } = req.params;

  if (role !== "ADMIN") {
    return res.status(403).json({ erreur: "Seul l'administrateur peut déverrouiller un établissement." });
  }

  const resultat = await prisma.verrouSaisieInitiale.deleteMany({
    where: { etablissementId },
  });

  if (resultat.count === 0) {
    return res.status(404).json({ erreur: "Aucun verrou trouvé pour cet établissement." });
  }

  return res.json({ message: `${resultat.count} verrou(s) levé(s).` });
}

// GET /verrouillage/mon-etat
// Permet à l'établissement connecté de savoir s'il est verrouillé (total ou
// par programme) avant de tenter une saisie, pour afficher le bon message côté
// frontend plutôt que de découvrir le blocage seulement à la soumission.
async function monEtatVerrouillage(req, res) {
  const { etablissementId } = req.utilisateur;
  if (!etablissementId) {
    return res.status(403).json({ erreur: "Cet utilisateur n'est rattaché à aucun établissement." });
  }

  const verrous = await prisma.verrouSaisieInitiale.findMany({
    where: { etablissementId },
    include: { programme: { select: { id: true, nom: true } }, posePar: { select: { nomComplet: true } } },
  });

  return res.json({
    verrouille: verrous.length > 0,
    verrouTotal: verrous.some((v) => v.programmeId === null),
    verrous,
  });
}

// GET /verrouillage
// Vue d'ensemble pour Admin : tous les verrous actuellement posés, tous
// établissements confondus.
async function listerVerrous(req, res) {
  const { role } = req.utilisateur;
  if (role !== "ADMIN") {
    return res.status(403).json({ erreur: "Réservé à l'administrateur." });
  }

  const verrous = await prisma.verrouSaisieInitiale.findMany({
    include: {
      etablissement: { select: { nom: true, type: true } },
      programme: { select: { nom: true } },
      posePar: { select: { nomComplet: true } },
    },
    orderBy: { dateVerrouillage: "desc" },
  });

  return res.json(verrous);
}

module.exports = {
  etatMaZone,
  verrouillerMaZone,
  verrouillerEtablissement,
  deverrouillerEtablissement,
  monEtatVerrouillage,
  listerVerrous,
};