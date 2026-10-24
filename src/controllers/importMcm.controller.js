const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// ---------------------------------------------------------------------------
// Import en masse des MEDECINS CHEFS de moughataa (MCM).
//
//   POST /equipe/import-mcm            (SAMEC Regional : ses moughataa seulement)
//   POST /admin/moughataa/import-mcm   (administrateur : tout le pays)
//
// multipart/form-data :
//   fichier     (.xlsx, .xls ou .csv ; seule la premiere feuille est lue)
//   simulation  "true" (defaut) = on analyse seulement, RIEN n'est cree
//               "false"         = on cree reellement
//
// Colonnes (ordre libre, accents/majuscules ignores) :
//   Moughataa, MCM (nom complet)   obligatoires
//   Telephone, Identifiant         optionnels
//
// Garde-fous :
//   - le MCM est rattache au depot GAS Moughataa de sa moughataa ;
//   - une moughataa qui a deja un MCM (ou qui apparait deux fois dans le
//     fichier) est ignoree ;
//   - une moughataa sans depot GAS Moughataa est refusee (rien n'est cree) ;
//   - une ligne en erreur n'empeche jamais les autres ; chaque ligne creee
//     (compte + rattachement) l'est dans UNE transaction ;
//   - aucune suppression, aucune modification d'existant.
// ---------------------------------------------------------------------------

const TAILLE_MAX_FICHIER = 5 * 1024 * 1024;
const LIGNES_MAX = 300;
const ROLE_MCM = "MEDECIN_CHEF_MOUGHATAA";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAILLE_MAX_FICHIER } }).single("fichier");

function cle(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function nomNormalise(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ALIAS_COLONNES = {
  moughataa: "moughataa",
  mcm: "mcm",
  medecinchef: "mcm",
  medecin: "mcm",
  nomcomplet: "mcm",
  nom: "mcm",
  telephone: "telephone",
  tel: "telephone",
  telephonemcm: "telephone",
  identifiant: "identifiant",
  identifiantmcm: "identifiant",
};

function lireFichier(fichier) {
  const nom = (fichier.originalname || "").toLowerCase();
  let classeur;
  if (nom.endsWith(".csv")) {
    const texte = fichier.buffer.toString("utf8").replace(/^\uFEFF/, "");
    const premiere = texte.split(/\r?\n/)[0] || "";
    const sep = (premiere.match(/;/g) || []).length > (premiere.match(/,/g) || []).length ? ";" : ",";
    classeur = XLSX.read(texte, { type: "string", FS: sep });
  } else {
    classeur = XLSX.read(fichier.buffer, { type: "buffer" });
  }
  const feuille = classeur.Sheets[classeur.SheetNames[0]];
  if (!feuille) return { erreur: "Le fichier ne contient aucune feuille." };

  const brut = XLSX.utils.sheet_to_json(feuille, { defval: "", raw: false });
  const lignes = brut.map((b) => {
    const ligne = {};
    for (const [entete, valeur] of Object.entries(b)) {
      const champ = ALIAS_COLONNES[cle(entete)];
      if (champ) ligne[champ] = String(valeur ?? "").trim();
    }
    return ligne;
  });
  const entetes = new Set();
  for (const b of brut.slice(0, 1)) {
    for (const entete of Object.keys(b)) {
      const champ = ALIAS_COLONNES[cle(entete)];
      if (champ) entetes.add(champ);
    }
  }
  return { lignes, entetes };
}

function motDePasseAleatoire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += alphabet[crypto.randomInt(alphabet.length)];
  return mdp;
}

function telephoneValide(valeur) {
  const brut = String(valeur ?? "").replace(/[\s.-]/g, "");
  if (!brut) return { valeur: null };
  if (!/^\+?\d{6,15}$/.test(brut)) return { erreur: "T\u00e9l\u00e9phone invalide (chiffres uniquement, 6 \u00e0 15)." };
  return { valeur: brut };
}

// Wilaya du SAMEC Regional connecte (son depot GAS_DRS porte le drsId).
async function drsDeLUtilisateur(req, res) {
  const depot = await prisma.etablissement.findUnique({
    where: { id: req.utilisateur.etablissementId },
    select: { type: true, drsId: true, drs: { select: { id: true, nom: true } } },
  });
  if (!depot || depot.type !== "GAS_DRS" || !depot.drsId || !depot.drs) {
    res.status(403).json({ erreur: "Ton \u00e9tablissement n'est rattach\u00e9 \u00e0 aucune wilaya : contacte l'administrateur." });
    return null;
  }
  return depot.drs;
}

async function traiter(req, res, admin) {
  let drs = null;
  if (!admin) {
    drs = await drsDeLUtilisateur(req, res);
    if (!drs) return;
  }
  const nomWilaya = drs ? drs.nom.replace(/^DRS\s+/i, "") : null;

  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier re\u00e7u. Choisis un fichier Excel ou CSV." });

  const simulation = String(req.body?.simulation ?? "true") !== "false";

  let lecture;
  try {
    lecture = lireFichier(req.file);
  } catch {
    return res.status(400).json({ erreur: "Fichier illisible : v\u00e9rifie qu'il s'agit bien d'un Excel (.xlsx) ou d'un CSV." });
  }
  if (lecture.erreur) return res.status(400).json({ erreur: lecture.erreur });

  const manquantes = ["moughataa", "mcm"].filter((c) => !lecture.entetes.has(c));
  if (manquantes.length > 0) {
    const libelles = { moughataa: "Moughataa", mcm: "MCM" };
    return res.status(400).json({
      erreur: `Colonne(s) manquante(s) dans la premi\u00e8re ligne : ${manquantes.map((c) => libelles[c]).join(", ")}.`,
    });
  }

  const { lignes } = lecture;
  if (lignes.length === 0) return res.status(400).json({ erreur: "Le fichier ne contient aucune ligne de donn\u00e9es." });
  if (lignes.length > LIGNES_MAX) {
    return res.status(400).json({ erreur: `Trop de lignes (${lignes.length}). Maximum ${LIGNES_MAX} par import.` });
  }

  // Moughataa autorisees : celles de ma wilaya (SAMEC Regional) ou toutes (admin).
  const moughataas = await prisma.moughataa.findMany({
    where: drs ? { drsId: drs.id } : {},
    select: { id: true, nom: true },
  });
  const parNom = {};
  for (const m of moughataas) (parNom[nomNormalise(m.nom)] = parNom[nomNormalise(m.nom)] || []).push(m);

  const idsMoughataa = moughataas.map((m) => m.id);
  const depots = await prisma.etablissement.findMany({
    where: { type: "GAS_MOUGHATAA", moughataaId: { in: idsMoughataa } },
    select: { id: true, moughataaId: true },
  });
  const depotsParMoughataa = {};
  for (const d of depots) (depotsParMoughataa[d.moughataaId] = depotsParMoughataa[d.moughataaId] || []).push(d);

  const mcmExistants = await prisma.userEtablissement.findMany({
    where: { role: ROLE_MCM, etablissement: { moughataaId: { in: idsMoughataa } } },
    select: { etablissementId: true },
  });
  const depotsAvecMcm = new Set(mcmExistants.map((x) => x.etablissementId));

  const identifiantsPris = new Set(
    (await prisma.utilisateur.findMany({ select: { identifiant: true } })).map((u) => u.identifiant.toLowerCase())
  );

  const resultats = [];

  for (let i = 0; i < lignes.length; i++) {
    const numero = i + 2;
    const l = lignes[i];
    const base = { ligne: numero, moughataa: l.moughataa || "", mcm: l.mcm || "" };

    if (!l.moughataa && !l.mcm && !l.telephone && !l.identifiant) continue;

    if (!l.moughataa) { resultats.push({ ...base, statut: "erreur", message: "Moughataa manquante." }); continue; }
    if (!l.mcm || l.mcm.length < 3) {
      resultats.push({ ...base, statut: "erreur", message: "Nom du m\u00e9decin chef manquant (3 caract\u00e8res minimum)." });
      continue;
    }

    const tel = telephoneValide(l.telephone);
    if (tel.erreur) { resultats.push({ ...base, statut: "erreur", message: tel.erreur }); continue; }

    const candidates = parNom[nomNormalise(l.moughataa)] || [];
    if (candidates.length === 0) {
      resultats.push({
        ...base,
        statut: "erreur",
        message: nomWilaya
          ? `Moughataa "${l.moughataa}" absente de ta wilaya (${nomWilaya}) : v\u00e9rifie l'orthographe ou contacte l'administrateur.`
          : `Moughataa "${l.moughataa}" introuvable : v\u00e9rifie l'orthographe.`,
      });
      continue;
    }
    if (candidates.length > 1) {
      resultats.push({ ...base, statut: "erreur", message: `Plusieurs moughataa portent le nom "${l.moughataa}".` });
      continue;
    }
    const moughataa = candidates[0];

    const depotsMoughataa = depotsParMoughataa[moughataa.id] || [];
    if (depotsMoughataa.length === 0) {
      resultats.push({ ...base, moughataa: moughataa.nom, statut: "erreur", message: "Cette moughataa n'a pas de d\u00e9p\u00f4t GAS Moughataa : cr\u00e9e-le d'abord." });
      continue;
    }
    if (depotsMoughataa.length > 1) {
      resultats.push({ ...base, moughataa: moughataa.nom, statut: "erreur", message: "Plusieurs d\u00e9p\u00f4ts GAS Moughataa pour cette moughataa : contacte l'administrateur." });
      continue;
    }
    const depot = depotsMoughataa[0];

    if (depotsAvecMcm.has(depot.id)) {
      resultats.push({
        ...base,
        moughataa: moughataa.nom,
        statut: "existe",
        message: "Cette moughataa a d\u00e9j\u00e0 un m\u00e9decin chef (ou est en double dans le fichier) : ignor\u00e9e.",
      });
      continue;
    }

    let identifiant;
    if (l.identifiant) {
      if (!/^[A-Za-z0-9._-]{3,40}$/.test(l.identifiant)) {
        resultats.push({ ...base, moughataa: moughataa.nom, statut: "erreur", message: "Identifiant invalide (3 \u00e0 40 caract\u00e8res : lettres, chiffres, point, tiret)." });
        continue;
      }
      if (identifiantsPris.has(l.identifiant.toLowerCase())) {
        resultats.push({ ...base, moughataa: moughataa.nom, statut: "erreur", message: `L'identifiant "${l.identifiant}" est d\u00e9j\u00e0 utilis\u00e9.` });
        continue;
      }
      identifiant = l.identifiant;
    } else {
      const racine = ("mcm." + nomNormalise(moughataa.nom).replace(/ /g, ".")).slice(0, 30);
      identifiant = racine;
      let n = 2;
      while (identifiantsPris.has(identifiant.toLowerCase())) {
        identifiant = `${racine}.${n}`;
        n += 1;
      }
    }

    // On reserve la moughataa et l'identifiant des maintenant (simulation comme
    // reel) pour reperer les doublons a l'interieur du fichier lui-meme.
    if (simulation) {
      depotsAvecMcm.add(depot.id);
      identifiantsPris.add(identifiant.toLowerCase());
      resultats.push({ ...base, moughataa: moughataa.nom, identifiant, statut: "a_creer", message: "Sera cr\u00e9\u00e9." });
      continue;
    }

    const motDePasse = motDePasseAleatoire();
    try {
      const motDePasseHash = await hashPassword(motDePasse);
      await prisma.$transaction(async (tx) => {
        const u = await tx.utilisateur.create({
          data: { nomComplet: l.mcm, identifiant, motDePasseHash, telephone: tel.valeur, estAdminSysteme: false },
        });
        await tx.userEtablissement.create({
          data: { utilisateurId: u.id, etablissementId: depot.id, role: ROLE_MCM },
        });
      });
      depotsAvecMcm.add(depot.id);
      identifiantsPris.add(identifiant.toLowerCase());
      resultats.push({ ...base, moughataa: moughataa.nom, identifiant, motDePasse, statut: "cree", message: "Cr\u00e9\u00e9." });
    } catch (err) {
      console.error(`[IMPORT MCM] ligne ${numero} :`, err);
      const message =
        err.code === "P2002"
          ? "Identifiant d\u00e9j\u00e0 utilis\u00e9."
          : "Erreur inattendue (ligne ignor\u00e9e, rien n'a \u00e9t\u00e9 enregistr\u00e9 pour elle).";
      resultats.push({ ...base, moughataa: moughataa.nom, statut: "erreur", message });
    }
  }

  const compte = (s) => resultats.filter((r) => r.statut === s).length;

  if (!simulation) {
    console.log(
      `[IMPORT MCM] ${new Date().toISOString()} \u2014 utilisateur ${req.utilisateur.utilisateurId} (${admin ? "admin" : "wilaya " + nomWilaya}) : ${compte("cree")} MCM cr\u00e9\u00e9(s)`
    );
  }

  return res.json({
    simulation,
    wilaya: nomWilaya,
    message: simulation
      ? `Simulation : ${compte("a_creer")} m\u00e9decin(s) chef(s) \u00e0 cr\u00e9er, ${compte("existe")} moughataa d\u00e9j\u00e0 pourvue(s), ${compte("erreur")} ligne(s) en erreur. Rien n'a \u00e9t\u00e9 enregistr\u00e9.`
      : `Import termin\u00e9 : ${compte("cree")} m\u00e9decin(s) chef(s) cr\u00e9\u00e9(s), ${compte("existe")} moughataa d\u00e9j\u00e0 pourvue(s), ${compte("erreur")} ligne(s) en erreur.`,
    resultats,
  });
}

function enveloppe(admin) {
  return function (req, res, next) {
    upload(req, res, (err) => {
      if (err) {
        const message =
          err.code === "LIMIT_FILE_SIZE" ? "Fichier trop volumineux (5 Mo maximum)." : "Le fichier n'a pas pu \u00eatre re\u00e7u. R\u00e9essaie.";
        return res.status(400).json({ erreur: message });
      }
      traiter(req, res, admin).catch(next);
    });
  };
}

module.exports = {
  importerMcmDrs: enveloppe(false),
  importerMcmAdmin: enveloppe(true),
};