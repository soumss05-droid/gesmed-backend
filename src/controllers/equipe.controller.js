const crypto = require("crypto");
const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// ---------------------------------------------------------------------------
// « Mon équipe » — création de comptes par le GAS DRS, limitée à SA région.
//
// Routes (voir equipe.routes.js, réservées au rôle GESTIONNAIRE_DRS) :
//   GET  /equipe/perimetre   moughataa, dépôts de moughataa et FOSA de sa région
//   GET  /equipe/comptes     comptes de sa région
//   POST /equipe/comptes     crée un compte (GAS Moughataa, MCM ou responsable FOSA)
//   POST /equipe/fosa        crée une FOSA + son responsable
//
// Garde-fous :
//   - la région est TOUJOURS déduite du compte connecté (jamais du corps de la
//     requête) : le GAS DRS ne peut rien créer hors de sa DRS ;
//   - rôles autorisés : GAS_MOUGHATAA, MEDECIN_CHEF_MOUGHATAA, FORMATION_SANITAIRE
//     (jamais un autre GAS DRS, un Directeur DRS, un admin, la CAMEC...) ;
//   - le mot de passe est généré par le serveur et n'est renvoyé qu'une fois ;
//   - aucune suppression, aucune modification de compte existant ici ;
//   - chaque création est enregistrée dans journal_equipe (vue admin).
// ---------------------------------------------------------------------------

const ROLES_CREABLES = ["GAS_MOUGHATAA", "MEDECIN_CHEF_MOUGHATAA", "FORMATION_SANITAIRE"];
const TYPE_ETABLISSEMENT_PAR_ROLE = {
  GAS_MOUGHATAA: "GAS_MOUGHATAA",
  MEDECIN_CHEF_MOUGHATAA: "GAS_MOUGHATAA", // le MCM est rattaché au dépôt de sa moughataa
  FORMATION_SANITAIRE: "FORMATION_SANITAIRE",
};

function nomNormalise(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function racineIdentifiant(texte) {
  return nomNormalise(texte).replace(/ /g, ".").slice(0, 30) || "compte";
}

// Mot de passe aléatoire de 8 caractères, sans caractères ambigus (0/O, 1/l/I).
function motDePasseAleatoire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += alphabet[crypto.randomInt(alphabet.length)];
  return mdp;
}

function nettoyerTelephone(valeur) {
  const brut = String(valeur ?? "").replace(/[\s.-]/g, "");
  if (!brut) return { valeur: null };
  if (!/^\+?\d{6,15}$/.test(brut)) return { erreur: "Téléphone invalide (chiffres uniquement, 6 à 15)." };
  return { valeur: brut };
}

// DRS de l'utilisateur connecté, déduite de son dépôt GAS_DRS.
async function drsDeLUtilisateur(req, res) {
  const depot = await prisma.etablissement.findUnique({
    where: { id: req.utilisateur.etablissementId },
    select: { id: true, nom: true, type: true, drsId: true, drs: { select: { id: true, nom: true } } },
  });
  if (!depot || depot.type !== "GAS_DRS" || !depot.drsId || !depot.drs) {
    res.status(403).json({ erreur: "Ton établissement n'est rattaché à aucune DRS : contacte l'administrateur." });
    return null;
  }
  return depot.drs; // { id, nom }
}

function filtreRegion(drsId, types) {
  return {
    type: { in: types },
    OR: [{ drsId }, { moughataa: { drsId } }],
  };
}

// Identifiant libre : racine, puis racine.2, racine.3...
async function identifiantLibre(racine) {
  let identifiant = racine;
  let n = 2;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.utilisateur.findUnique({ where: { identifiant }, select: { id: true } })) {
    identifiant = `${racine}.${n}`;
    n += 1;
  }
  return identifiant;
}

async function verifierIdentifiantDemande(identifiant) {
  const existe = await prisma.utilisateur.findUnique({ where: { identifiant }, select: { id: true } });
  return !existe;
}

// Trace d'audit : journal du serveur + ligne dans la table journal_equipe,
// que l'administrateur consulte dans son écran « Activité des DRS ».
// L'écriture dans la table ne doit JAMAIS faire échouer la création du compte
// (déjà faite à ce stade) : en cas de problème on le signale dans la console.
async function tracer(req, drs, texte, entree) {
  console.log(`[EQUIPE] ${new Date().toISOString()} — utilisateur ${req.utilisateur.utilisateurId} (DRS ${drs.nom}) : ${texte}`);
  try {
    const auteur = await prisma.utilisateur.findUnique({
      where: { id: req.utilisateur.utilisateurId },
      select: { nomComplet: true },
    });
    await prisma.journalEquipe.create({
      data: {
        auteurId: req.utilisateur.utilisateurId,
        auteurNom: auteur?.nomComplet || "—",
        drsId: drs.id,
        drsNom: drs.nom,
        action: entree.action,
        role: entree.role || null,
        etablissementNom: entree.etablissementNom,
        compteNom: entree.compteNom,
        identifiant: entree.identifiant,
      },
    });
  } catch (e) {
    console.error("[EQUIPE] Journal non enregistré (la table journal_equipe existe-t-elle ?) :", e.message);
  }
}

// GET /equipe/perimetre
async function perimetre(req, res) {
  const drs = await drsDeLUtilisateur(req, res);
  if (!drs) return;

  const [moughataas, depots, fosa] = await Promise.all([
    prisma.moughataa.findMany({ where: { drsId: drs.id }, select: { id: true, nom: true }, orderBy: { nom: "asc" } }),
    prisma.etablissement.findMany({
      where: filtreRegion(drs.id, ["GAS_MOUGHATAA"]),
      select: { id: true, nom: true, moughataa: { select: { nom: true } } },
      orderBy: { nom: "asc" },
    }),
    prisma.etablissement.findMany({
      where: filtreRegion(drs.id, ["FORMATION_SANITAIRE"]),
      select: { id: true, nom: true, moughataa: { select: { nom: true } } },
      orderBy: { nom: "asc" },
    }),
  ]);

  return res.json({
    drs,
    roles: ROLES_CREABLES,
    moughataas,
    depotsMoughataa: depots.map((d) => ({ id: d.id, nom: d.nom, moughataa: d.moughataa?.nom || null })),
    fosa: fosa.map((f) => ({ id: f.id, nom: f.nom, moughataa: f.moughataa?.nom || null })),
  });
}

// GET /equipe/comptes
async function listerComptes(req, res) {
  const drs = await drsDeLUtilisateur(req, res);
  if (!drs) return;

  const rattachements = await prisma.userEtablissement.findMany({
    where: { etablissement: filtreRegion(drs.id, ["GAS_MOUGHATAA", "FORMATION_SANITAIRE"]) },
    include: {
      utilisateur: { select: { id: true, nomComplet: true, identifiant: true, telephone: true, actif: true, createdAt: true } },
      etablissement: { select: { id: true, nom: true, type: true, moughataa: { select: { nom: true } } } },
    },
    orderBy: { dateDebut: "desc" },
  });

  return res.json(
    rattachements.map((r) => ({
      rattachementId: r.id,
      utilisateurId: r.utilisateur.id,
      nomComplet: r.utilisateur.nomComplet,
      identifiant: r.utilisateur.identifiant,
      telephone: r.utilisateur.telephone,
      actif: r.utilisateur.actif && r.actif,
      creeLe: r.utilisateur.createdAt,
      role: r.role,
      etablissement: r.etablissement.nom,
      moughataa: r.etablissement.moughataa?.nom || null,
    }))
  );
}

// POST /equipe/comptes
// Body : { nomComplet, telephone?, identifiant?, etablissementId, role }
async function creerCompte(req, res) {
  const drs = await drsDeLUtilisateur(req, res);
  if (!drs) return;

  const { nomComplet, telephone, identifiant, etablissementId, role } = req.body || {};
  const nom = String(nomComplet ?? "").trim();

  if (nom.length < 3 || nom.length > 120) {
    return res.status(400).json({ erreur: "Nom complet requis (3 à 120 caractères)." });
  }
  if (!ROLES_CREABLES.includes(role)) {
    return res.status(403).json({ erreur: "Tu ne peux créer que des comptes GAS Moughataa, MCM ou responsable de FOSA." });
  }
  if (!etablissementId) return res.status(400).json({ erreur: "Établissement requis." });

  const tel = nettoyerTelephone(telephone);
  if (tel.erreur) return res.status(400).json({ erreur: tel.erreur });

  // L'établissement doit être dans la région, du bon type pour ce rôle.
  const etablissement = await prisma.etablissement.findFirst({
    where: { id: etablissementId, ...filtreRegion(drs.id, [TYPE_ETABLISSEMENT_PAR_ROLE[role]]) },
    select: { id: true, nom: true, moughataa: { select: { nom: true } } },
  });
  if (!etablissement) {
    return res.status(403).json({ erreur: "Cet établissement n'existe pas dans ta région ou ne correspond pas à ce rôle." });
  }

  // Doublon : même nom déjà rattaché au même établissement.
  const rattaches = await prisma.userEtablissement.findMany({
    where: { etablissementId: etablissement.id },
    select: { role: true, utilisateur: { select: { nomComplet: true } } },
  });
  if (rattaches.some((r) => r.role === role && nomNormalise(r.utilisateur.nomComplet) === nomNormalise(nom))) {
    return res.status(409).json({ erreur: "Un compte avec ce nom et ce rôle existe déjà dans cet établissement." });
  }

  // Identifiant : demandé (doit être libre) ou généré.
  let identifiantFinal;
  const demande = String(identifiant ?? "").trim();
  if (demande) {
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(demande)) {
      return res.status(400).json({ erreur: "Identifiant invalide (3 à 40 caractères : lettres, chiffres, point, tiret)." });
    }
    if (!(await verifierIdentifiantDemande(demande))) {
      return res.status(409).json({ erreur: `L'identifiant "${demande}" est déjà utilisé.` });
    }
    identifiantFinal = demande;
  } else {
    let racine;
    if (role === "FORMATION_SANITAIRE") racine = racineIdentifiant(etablissement.nom);
    else racine = `${role === "GAS_MOUGHATAA" ? "gas" : "mcm"}.${racineIdentifiant(etablissement.moughataa?.nom || etablissement.nom)}`;
    identifiantFinal = await identifiantLibre(racine);
  }

  const motDePasse = motDePasseAleatoire();
  const motDePasseHash = await hashPassword(motDePasse);

  try {
    const utilisateur = await prisma.$transaction(async (tx) => {
      const u = await tx.utilisateur.create({
        data: { nomComplet: nom, identifiant: identifiantFinal, motDePasseHash, telephone: tel.valeur, estAdminSysteme: false },
      });
      await tx.userEtablissement.create({ data: { utilisateurId: u.id, etablissementId: etablissement.id, role } });
      return u;
    });
    await tracer(req, drs, `compte créé « ${utilisateur.identifiant} » (${role}) pour ${etablissement.nom}`, {
      action: "COMPTE_CREE",
      role,
      etablissementNom: etablissement.nom,
      compteNom: nom,
      identifiant: utilisateur.identifiant,
    });
    return res.status(201).json({
      message: "Compte créé. Communique l'identifiant et le mot de passe à la personne : le mot de passe ne sera plus affiché.",
      compte: { nomComplet: nom, identifiant: utilisateur.identifiant, motDePasse, role, etablissement: etablissement.nom },
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ erreur: "Cet identifiant est déjà utilisé." });
    throw err;
  }
}

// POST /equipe/fosa
// Body : { nom, moughataaId, responsable, telephone?, identifiant? }
async function creerFosa(req, res) {
  const drs = await drsDeLUtilisateur(req, res);
  if (!drs) return;

  const { nom, moughataaId, responsable, telephone, identifiant } = req.body || {};
  const nomFosa = String(nom ?? "").trim();
  const nomResponsable = String(responsable ?? "").trim();

  if (nomFosa.length < 2 || nomFosa.length > 120) return res.status(400).json({ erreur: "Nom de la FOSA requis (2 à 120 caractères)." });
  if (nomResponsable.length < 3 || nomResponsable.length > 120) {
    return res.status(400).json({ erreur: "Nom complet du responsable requis (3 à 120 caractères)." });
  }
  if (!moughataaId) return res.status(400).json({ erreur: "Moughataa requise." });

  const tel = nettoyerTelephone(telephone);
  if (tel.erreur) return res.status(400).json({ erreur: tel.erreur });

  const moughataa = await prisma.moughataa.findFirst({
    where: { id: moughataaId, drsId: drs.id },
    select: { id: true, nom: true, drsId: true },
  });
  if (!moughataa) return res.status(403).json({ erreur: "Cette moughataa n'est pas dans ta région." });

  const memeNom = await prisma.etablissement.findMany({
    where: { type: "FORMATION_SANITAIRE", moughataaId: moughataa.id },
    select: { nom: true },
  });
  if (memeNom.some((f) => nomNormalise(f.nom) === nomNormalise(nomFosa))) {
    return res.status(409).json({ erreur: `La FOSA "${nomFosa}" existe déjà dans la moughataa ${moughataa.nom}.` });
  }

  let identifiantFinal;
  const demande = String(identifiant ?? "").trim();
  if (demande) {
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(demande)) {
      return res.status(400).json({ erreur: "Identifiant invalide (3 à 40 caractères : lettres, chiffres, point, tiret)." });
    }
    if (!(await verifierIdentifiantDemande(demande))) {
      return res.status(409).json({ erreur: `L'identifiant "${demande}" est déjà utilisé.` });
    }
    identifiantFinal = demande;
  } else {
    identifiantFinal = await identifiantLibre(racineIdentifiant(nomFosa));
  }

  const motDePasse = motDePasseAleatoire();
  const motDePasseHash = await hashPassword(motDePasse);

  try {
    const cree = await prisma.$transaction(async (tx) => {
      const etablissement = await tx.etablissement.create({
        data: {
          nom: nomFosa,
          type: "FORMATION_SANITAIRE",
          aStockPhysique: true,
          moughataaId: moughataa.id,
          drsId: moughataa.drsId, // rattachée à la DRS dès la création
        },
      });
      const u = await tx.utilisateur.create({
        data: { nomComplet: nomResponsable, identifiant: identifiantFinal, motDePasseHash, telephone: tel.valeur, estAdminSysteme: false },
      });
      await tx.userEtablissement.create({
        data: { utilisateurId: u.id, etablissementId: etablissement.id, role: "FORMATION_SANITAIRE" },
      });
      return { etablissement, u };
    });
    await tracer(req, drs, `FOSA créée « ${cree.etablissement.nom} » (${moughataa.nom}) avec le compte « ${cree.u.identifiant} »`, {
      action: "FOSA_CREEE",
      role: "FORMATION_SANITAIRE",
      etablissementNom: cree.etablissement.nom,
      compteNom: nomResponsable,
      identifiant: cree.u.identifiant,
    });
    return res.status(201).json({
      message: "FOSA créée avec son responsable. Communique l'identifiant et le mot de passe : le mot de passe ne sera plus affiché.",
      compte: {
        nomComplet: nomResponsable,
        identifiant: cree.u.identifiant,
        motDePasse,
        role: "FORMATION_SANITAIRE",
        etablissement: cree.etablissement.nom,
      },
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ erreur: "Cet identifiant est déjà utilisé." });
    throw err;
  }
}

module.exports = { perimetre, listerComptes, creerCompte, creerFosa };