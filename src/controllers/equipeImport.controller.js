const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// ---------------------------------------------------------------------------
// POST /equipe/import-fosa  (réservé au GAS DRS, voir equipe.routes.js)
// multipart/form-data :
//   fichier     (.xlsx, .xls ou .csv)
//   simulation  "true" (défaut) = on analyse seulement, RIEN n'est créé
//               "false"         = on crée réellement
//
// Colonnes (ordre libre, accents/majuscules ignorés) :
//   Nom FOSA, Moughataa, Responsable  (obligatoires)
//   Telephone, Identifiant            (optionnels)
//
// Garde-fous :
//   - seules les moughataa de LA région du GAS DRS connecté sont acceptées ;
//   - une FOSA déjà présente (même nom, même moughataa) est ignorée ;
//   - une ligne en erreur n'empêche jamais les autres ; chaque ligne créée
//     (FOSA + responsable + rattachement) l'est dans UNE transaction ;
//   - aucune suppression, aucune modification d'existant ;
//   - chaque FOSA créée est inscrite dans journal_equipe (vue admin).
// ---------------------------------------------------------------------------

const TAILLE_MAX_FICHIER = 5 * 1024 * 1024;
const LIGNES_MAX = 300;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAILLE_MAX_FICHIER } }).single("fichier");

function cle(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function nomNormalise(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
    const texte = fichier.buffer.toString("utf8").replace(/^﻿/, "");
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
  if (!/^\+?\d{6,15}$/.test(brut)) return { erreur: "Téléphone invalide (chiffres uniquement, 6 à 15)." };
  return { valeur: brut };
}

async function drsDeLUtilisateur(req, res) {
  const depot = await prisma.etablissement.findUnique({
    where: { id: req.utilisateur.etablissementId },
    select: { type: true, drsId: true, drs: { select: { id: true, nom: true } } },
  });
  if (!depot || depot.type !== "GAS_DRS" || !depot.drsId || !depot.drs) {
    res.status(403).json({ erreur: "Ton établissement n'est rattaché à aucune DRS : contacte l'administrateur." });
    return null;
  }
  return depot.drs;
}

async function traiter(req, res) {
  const drs = await drsDeLUtilisateur(req, res);
  if (!drs) return;

  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu. Choisis un fichier Excel ou CSV." });

  // Simulation par défaut : on ne crée que si on reçoit explicitement "false".
  const simulation = String(req.body?.simulation ?? "true") !== "false";

  let lecture;
  try {
    lecture = lireFichier(req.file);
  } catch {
    return res.status(400).json({ erreur: "Fichier illisible : vérifie qu'il s'agit bien d'un Excel (.xlsx) ou d'un CSV." });
  }
  if (lecture.erreur) return res.status(400).json({ erreur: lecture.erreur });

  const manquantes = ["nomFosa", "moughataa", "responsable"].filter((c) => !lecture.entetes.has(c));
  if (manquantes.length > 0) {
    const libelles = { nomFosa: "Nom FOSA", moughataa: "Moughataa", responsable: "Responsable" };
    return res.status(400).json({
      erreur: `Colonne(s) manquante(s) dans la première ligne : ${manquantes.map((c) => libelles[c]).join(", ")}.`,
    });
  }

  const { lignes } = lecture;
  if (lignes.length === 0) return res.status(400).json({ erreur: "Le fichier ne contient aucune ligne de données." });
  if (lignes.length > LIGNES_MAX) {
    return res.status(400).json({ erreur: `Trop de lignes (${lignes.length}). Maximum ${LIGNES_MAX} par import.` });
  }

  // UNIQUEMENT les moughataa de ma région.
  const moughataas = await prisma.moughataa.findMany({ where: { drsId: drs.id }, select: { id: true, nom: true, drsId: true } });
  const parNom = {};
  for (const m of moughataas) (parNom[nomNormalise(m.nom)] = parNom[nomNormalise(m.nom)] || []).push(m);

  const existantes = await prisma.etablissement.findMany({
    where: { type: "FORMATION_SANITAIRE", moughataaId: { in: moughataas.map((m) => m.id) } },
    select: { nom: true, moughataaId: true },
  });
  const fosaPresentes = new Set(existantes.map((f) => `${f.moughataaId}|${nomNormalise(f.nom)}`));
  const identifiantsPris = new Set(
    (await prisma.utilisateur.findMany({ select: { identifiant: true } })).map((u) => u.identifiant.toLowerCase())
  );

  const resultats = [];
  const aJournaliser = [];

  for (let i = 0; i < lignes.length; i++) {
    const numero = i + 2;
    const l = lignes[i];
    const base = { ligne: numero, nomFosa: l.nomFosa || "", moughataa: l.moughataa || "", responsable: l.responsable || "" };

    if (!l.nomFosa && !l.moughataa && !l.responsable && !l.telephone && !l.identifiant) continue;

    if (!l.nomFosa) { resultats.push({ ...base, statut: "erreur", message: "Nom de la FOSA manquant." }); continue; }
    if (!l.moughataa) { resultats.push({ ...base, statut: "erreur", message: "Moughataa manquante." }); continue; }
    if (!l.responsable || l.responsable.length < 3) {
      resultats.push({ ...base, statut: "erreur", message: "Nom du responsable manquant (3 caractères minimum)." });
      continue;
    }

    const tel = telephoneValide(l.telephone);
    if (tel.erreur) { resultats.push({ ...base, statut: "erreur", message: tel.erreur }); continue; }

    const candidates = parNom[nomNormalise(l.moughataa)] || [];
    if (candidates.length === 0) {
      resultats.push({
        ...base,
        statut: "erreur",
        message: `Moughataa "${l.moughataa}" absente de ta région (${drs.nom}) : vérifie l'orthographe ou contacte l'administrateur.`,
      });
      continue;
    }
    if (candidates.length > 1) {
      resultats.push({ ...base, statut: "erreur", message: `Plusieurs moughataa portent le nom "${l.moughataa}" dans ta région.` });
      continue;
    }
    const moughataa = candidates[0];

    const cleFosa = `${moughataa.id}|${nomNormalise(l.nomFosa)}`;
    if (fosaPresentes.has(cleFosa)) {
      resultats.push({ ...base, statut: "existe", message: `La FOSA "${l.nomFosa}" existe déjà (ou est en double dans le fichier) : ignorée.` });
      continue;
    }

    let identifiant;
    if (l.identifiant) {
      if (!/^[A-Za-z0-9._-]{3,40}$/.test(l.identifiant)) {
        resultats.push({ ...base, statut: "erreur", message: "Identifiant invalide (3 à 40 caractères : lettres, chiffres, point, tiret)." });
        continue;
      }
      if (identifiantsPris.has(l.identifiant.toLowerCase())) {
        resultats.push({ ...base, statut: "erreur", message: `L'identifiant "${l.identifiant}" est déjà utilisé.` });
        continue;
      }
      identifiant = l.identifiant;
    } else {
      const racine = nomNormalise(l.nomFosa).replace(/ /g, ".").slice(0, 30) || "fosa";
      identifiant = racine;
      let n = 2;
      while (identifiantsPris.has(identifiant.toLowerCase())) {
        identifiant = `${racine}.${n}`;
        n += 1;
      }
    }

    // On réserve la FOSA et l'identifiant dès maintenant (simulation comme
    // réel) pour repérer les doublons à l'intérieur du fichier lui-même.
    if (simulation) {
      fosaPresentes.add(cleFosa);
      identifiantsPris.add(identifiant.toLowerCase());
      resultats.push({ ...base, moughataa: moughataa.nom, identifiant, statut: "a_creer", message: "Sera créée." });
      continue;
    }

    const motDePasse = motDePasseAleatoire();
    try {
      const motDePasseHash = await hashPassword(motDePasse);
      await prisma.$transaction(async (tx) => {
        const etab = await tx.etablissement.create({
          data: {
            nom: l.nomFosa,
            type: "FORMATION_SANITAIRE",
            aStockPhysique: true,
            moughataaId: moughataa.id,
            drsId: moughataa.drsId,
          },
        });
        const u = await tx.utilisateur.create({
          data: { nomComplet: l.responsable, identifiant, motDePasseHash, telephone: tel.valeur, estAdminSysteme: false },
        });
        await tx.userEtablissement.create({
          data: { utilisateurId: u.id, etablissementId: etab.id, role: "FORMATION_SANITAIRE" },
        });
      });
      fosaPresentes.add(cleFosa);
      identifiantsPris.add(identifiant.toLowerCase());
      resultats.push({ ...base, moughataa: moughataa.nom, identifiant, motDePasse, statut: "cree", message: "Créée." });
      aJournaliser.push({ etablissementNom: l.nomFosa, compteNom: l.responsable, identifiant });
    } catch (err) {
      console.error(`[EQUIPE] Import FOSA, ligne ${numero} :`, err);
      const message =
        err.code === "P2002"
          ? "Identifiant déjà utilisé."
          : "Erreur inattendue (ligne ignorée, rien n'a été enregistré pour elle).";
      resultats.push({ ...base, statut: "erreur", message });
    }
  }

  const compte = (s) => resultats.filter((r) => r.statut === s).length;

  if (!simulation) {
    console.log(`[EQUIPE] ${new Date().toISOString()} — utilisateur ${req.utilisateur.utilisateurId} (DRS ${drs.nom}) : import FOSA, ${aJournaliser.length} créée(s)`);
    if (aJournaliser.length > 0) {
      try {
        const auteur = await prisma.utilisateur.findUnique({
          where: { id: req.utilisateur.utilisateurId },
          select: { nomComplet: true },
        });
        await prisma.journalEquipe.createMany({
          data: aJournaliser.map((j) => ({
            auteurId: req.utilisateur.utilisateurId,
            auteurNom: auteur?.nomComplet || "—",
            drsId: drs.id,
            drsNom: drs.nom,
            action: "FOSA_CREEE",
            role: "FORMATION_SANITAIRE",
            etablissementNom: j.etablissementNom,
            compteNom: j.compteNom,
            identifiant: j.identifiant,
          })),
        });
      } catch (e) {
        console.error("[EQUIPE] Journal non enregistré (la table journal_equipe existe-t-elle ?) :", e.message);
      }
    }
  }

  return res.json({
    simulation,
    drs: drs.nom,
    message: simulation
      ? `Simulation : ${compte("a_creer")} FOSA à créer, ${compte("existe")} déjà présente(s), ${compte("erreur")} ligne(s) en erreur. Rien n'a été enregistré.`
      : `Import terminé : ${compte("cree")} FOSA créée(s), ${compte("existe")} déjà présente(s), ${compte("erreur")} ligne(s) en erreur.`,
    resultats,
  });
}

function importerFosaDrs(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "Fichier trop volumineux (5 Mo maximum)." : "Le fichier n'a pas pu être reçu. Réessaie.";
      return res.status(400).json({ erreur: message });
    }
    traiter(req, res).catch(next);
  });
}

module.exports = { importerFosaDrs };