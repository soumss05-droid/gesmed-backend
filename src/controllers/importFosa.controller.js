const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// ---------------------------------------------------------------------------
// POST /admin/etablissements/import-fosa
// multipart/form-data, champ "fichier" (.xlsx, .xls ou .csv).
//
// Colonnes attendues (l'ordre n'a pas d'importance, les accents et les
// majuscules sont ignorés) :
//   Nom FOSA      (obligatoire)
//   Moughataa     (obligatoire — nom exact d'une Moughataa déjà créée)
//   Responsable   (obligatoire — nom complet)
//   Telephone     (optionnel)
//   Identifiant   (optionnel — généré automatiquement s'il est vide)
//
// Pour chaque ligne valide : une formation sanitaire + un compte responsable
// (mot de passe aléatoire) rattaché à cette FOSA avec le rôle
// FORMATION_SANITAIRE, créés ensemble dans une transaction : si une étape
// échoue, rien n'est enregistré pour cette ligne. Une ligne en erreur
// n'empêche jamais les autres d'être importées.
//
// Réponse : { message, resultats: [{ ligne, nomFosa, moughataa, responsable,
// identifiant, motDePasse, statut: "ok" | "erreur", message }] }
// Le mot de passe en clair n'est renvoyé que dans cette réponse.
// ---------------------------------------------------------------------------

const TAILLE_MAX_FICHIER = 5 * 1024 * 1024; // 5 Mo
const LIGNES_MAX = 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_FICHIER },
}).single("fichier");

// Minuscules, sans accents, sans espaces ni ponctuation : sert à comparer
// des en-têtes de colonnes ("Nom FOSA", "nom_fosa", "NOM FOSA " -> "nomfosa").
function cle(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Comparaison de noms (FOSA, Moughataa) : mêmes règles, mais on garde les
// espaces simples pour ne pas confondre des noms différents.
function nomNormalise(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ALIAS_COLONNES = {
  nomfosa: "nomFosa",
  fosa: "nomFosa",
  nom: "nomFosa",
  moughataa: "moughataa",
  responsable: "responsable",
  telephone: "telephone",
  tel: "telephone",
  identifiant: "identifiant",
};

function lireFichier(fichier) {
  const nom = (fichier.originalname || "").toLowerCase();
  let classeur;
  if (nom.endsWith(".csv")) {
    // CSV : on détecte le séparateur (Excel français exporte souvent en ";").
    const texte = fichier.buffer.toString("utf8").replace(/^\uFEFF/, "");
    const premiereLigne = texte.split(/\r?\n/)[0] || "";
    const separateur = (premiereLigne.match(/;/g) || []).length > (premiereLigne.match(/,/g) || []).length ? ";" : ",";
    classeur = XLSX.read(texte, { type: "string", FS: separateur });
  } else {
    classeur = XLSX.read(fichier.buffer, { type: "buffer" });
  }

  const feuille = classeur.Sheets[classeur.SheetNames[0]];
  if (!feuille) return { erreur: "Le fichier ne contient aucune feuille." };

  const brut = XLSX.utils.sheet_to_json(feuille, { defval: "", raw: false });
  const lignes = brut.map((ligneBrute) => {
    const ligne = {};
    for (const [entete, valeur] of Object.entries(ligneBrute)) {
      const champ = ALIAS_COLONNES[cle(entete)];
      if (champ) ligne[champ] = String(valeur ?? "").trim();
    }
    return ligne;
  });

  const entetesTrouvees = new Set();
  for (const ligneBrute of brut.slice(0, 1)) {
    for (const entete of Object.keys(ligneBrute)) {
      const champ = ALIAS_COLONNES[cle(entete)];
      if (champ) entetesTrouvees.add(champ);
    }
  }
  return { lignes, entetesTrouvees };
}

// Identifiant lisible à partir du nom de la FOSA : "CS Arafat 1" -> "cs.arafat.1".
function identifiantDepuisNom(nomFosa) {
  const base = nomNormalise(nomFosa).replace(/ /g, ".").slice(0, 30) || "fosa";
  return base;
}

// Mot de passe aléatoire de 8 caractères, sans caractères ambigus (0/O, 1/l/I).
function motDePasseAleatoire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += alphabet[crypto.randomInt(alphabet.length)];
  return mdp;
}

async function traiterImport(req, res) {
  if (!req.file) {
    return res.status(400).json({ erreur: "Aucun fichier reçu. Choisis un fichier Excel ou CSV." });
  }

  let lecture;
  try {
    lecture = lireFichier(req.file);
  } catch (err) {
    return res.status(400).json({ erreur: "Fichier illisible : vérifie qu'il s'agit bien d'un Excel (.xlsx) ou d'un CSV." });
  }
  if (lecture.erreur) return res.status(400).json({ erreur: lecture.erreur });

  const manquantes = ["nomFosa", "moughataa", "responsable"].filter((c) => !lecture.entetesTrouvees.has(c));
  if (manquantes.length > 0) {
    const libelles = { nomFosa: "Nom FOSA", moughataa: "Moughataa", responsable: "Responsable" };
    return res.status(400).json({
      erreur: `Colonne(s) manquante(s) dans la première ligne du fichier : ${manquantes.map((c) => libelles[c]).join(", ")}.`,
    });
  }

  const { lignes } = lecture;
  if (lignes.length === 0) {
    return res.status(400).json({ erreur: "Le fichier ne contient aucune ligne de données." });
  }
  if (lignes.length > LIGNES_MAX) {
    return res.status(400).json({ erreur: `Trop de lignes (${lignes.length}). Maximum ${LIGNES_MAX} par import.` });
  }

  // Chargé une seule fois : toutes les Moughataa (pour retrouver la bonne par
  // son nom) et les FOSA existantes (pour éviter les doublons).
  const moughataas = await prisma.moughataa.findMany({ select: { id: true, nom: true } });
  const moughataasParNom = {};
  for (const m of moughataas) {
    const k = nomNormalise(m.nom);
    (moughataasParNom[k] = moughataasParNom[k] || []).push(m);
  }
  const fosaExistantes = await prisma.etablissement.findMany({
    where: { type: "FORMATION_SANITAIRE" },
    select: { nom: true, moughataaId: true },
  });
  const fosaPresentes = new Set(fosaExistantes.map((f) => `${f.moughataaId}|${nomNormalise(f.nom)}`));
  const identifiantsPris = new Set(
    (await prisma.utilisateur.findMany({ select: { identifiant: true } })).map((u) => u.identifiant.toLowerCase())
  );

  const resultats = [];

  for (let i = 0; i < lignes.length; i++) {
    const numeroLigne = i + 2; // +1 pour l'en-tête, +1 car Excel compte à partir de 1
    const l = lignes[i];
    const base = {
      ligne: numeroLigne,
      nomFosa: l.nomFosa || "",
      moughataa: l.moughataa || "",
      responsable: l.responsable || "",
    };

    // Ligne entièrement vide : ignorée sans bruit.
    if (!l.nomFosa && !l.moughataa && !l.responsable && !l.telephone && !l.identifiant) continue;

    if (!l.nomFosa) {
      resultats.push({ ...base, statut: "erreur", message: "Nom de la FOSA manquant." });
      continue;
    }
    if (!l.moughataa) {
      resultats.push({ ...base, statut: "erreur", message: "Moughataa manquante." });
      continue;
    }
    if (!l.responsable) {
      resultats.push({ ...base, statut: "erreur", message: "Nom du responsable manquant." });
      continue;
    }

    const candidates = moughataasParNom[nomNormalise(l.moughataa)] || [];
    if (candidates.length === 0) {
      resultats.push({
        ...base,
        statut: "erreur",
        message: `Moughataa "${l.moughataa}" introuvable : crée-la d'abord dans l'onglet Régions, ou corrige l'orthographe.`,
      });
      continue;
    }
    if (candidates.length > 1) {
      resultats.push({
        ...base,
        statut: "erreur",
        message: `Plusieurs Moughataa portent le nom "${l.moughataa}" : impossible de choisir automatiquement.`,
      });
      continue;
    }
    const moughataa = candidates[0];

    const cleFosa = `${moughataa.id}|${nomNormalise(l.nomFosa)}`;
    if (fosaPresentes.has(cleFosa)) {
      resultats.push({
        ...base,
        statut: "erreur",
        message: `La FOSA "${l.nomFosa}" existe déjà dans la Moughataa ${moughataa.nom} : ignorée.`,
      });
      continue;
    }

    // Identifiant : fourni (doit être libre) ou généré (suffixe numérique si pris).
    let identifiant;
    if (l.identifiant) {
      identifiant = l.identifiant;
      if (identifiantsPris.has(identifiant.toLowerCase())) {
        resultats.push({ ...base, statut: "erreur", message: `L'identifiant "${identifiant}" est déjà utilisé.` });
        continue;
      }
    } else {
      const racine = identifiantDepuisNom(l.nomFosa);
      identifiant = racine;
      let n = 2;
      while (identifiantsPris.has(identifiant.toLowerCase())) {
        identifiant = `${racine}.${n}`;
        n += 1;
      }
    }

    const motDePasse = motDePasseAleatoire();

    try {
      const motDePasseHash = await hashPassword(motDePasse);
      await prisma.$transaction(async (tx) => {
        const etablissement = await tx.etablissement.create({
          data: {
            nom: l.nomFosa,
            type: "FORMATION_SANITAIRE",
            aStockPhysique: true,
            moughataaId: moughataa.id,
          },
        });
        const utilisateur = await tx.utilisateur.create({
          data: {
            nomComplet: l.responsable,
            identifiant,
            motDePasseHash,
            telephone: l.telephone || null,
            estAdminSysteme: false,
          },
        });
        await tx.userEtablissement.create({
          data: { utilisateurId: utilisateur.id, etablissementId: etablissement.id, role: "FORMATION_SANITAIRE" },
        });
      });

      fosaPresentes.add(cleFosa);
      identifiantsPris.add(identifiant.toLowerCase());
      resultats.push({ ...base, identifiant, motDePasse, statut: "ok", message: "Créée." });
    } catch (err) {
      console.error(`Import FOSA, ligne ${numeroLigne} :`, err);
      const message =
        err.code === "P2002"
          ? "Identifiant déjà utilisé."
          : "Erreur inattendue lors de la création (ligne ignorée, rien n'a été enregistré pour elle).";
      resultats.push({ ...base, statut: "erreur", message });
    }
  }

  const nbOk = resultats.filter((r) => r.statut === "ok").length;
  const nbErreur = resultats.length - nbOk;
  return res.json({
    message: `Import terminé : ${nbOk} FOSA créée(s), ${nbErreur} ligne(s) en erreur.`,
    resultats,
  });
}

// POST /admin/etablissements/import-fosa
// Enveloppe multer pour renvoyer une erreur JSON claire (fichier trop gros,
// mauvais champ...) plutôt que la page d'erreur HTML par défaut d'Express.
function importerFosa(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Fichier trop volumineux (5 Mo maximum)."
          : "Le fichier n'a pas pu être reçu. Réessaie.";
      return res.status(400).json({ erreur: message });
    }
    traiterImport(req, res).catch(next);
  });
}

module.exports = { importerFosa };