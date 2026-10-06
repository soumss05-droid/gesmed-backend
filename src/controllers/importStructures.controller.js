const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const prisma = require("../config/prisma");
const { hashPassword } = require("../utils/hash");

// ---------------------------------------------------------------------------
// Imports en masse de la structure du réseau :
//
//   POST /admin/drs/import        -> Directions régionales (DRS) + leur dépôt
//   POST /admin/moughataa/import  -> Moughataa + leur dépôt
//
// multipart/form-data, champ "fichier" (.xlsx, .xls ou .csv). Les accents,
// les majuscules et la ponctuation des en-têtes de colonnes sont ignorés.
//
// ----- Import DRS (une ligne = une région) -----
//   Region        (obligatoire)  nom de la Direction régionale
//   Code          (obligatoire si la DRS n'existe pas encore ; unique)
//   Depot         (optionnel)    nom du dépôt ; sinon "Dépôt de la DRS <Region>"
//   GAS           (obligatoire)  gestionnaire du dépôt -> rôle GESTIONNAIRE_DRS
//   Telephone GAS, Identifiant GAS      (optionnels)
//   Directeur     (optionnel)    directeur régional -> rôle DIRECTEUR_DRS
//   Telephone Directeur, Identifiant Directeur   (optionnels)
//
// ----- Import Moughataa (une ligne = une moughataa) -----
//   Moughataa     (obligatoire)
//   Region        (obligatoire)  nom d'une DRS déjà créée
//   Depot         (optionnel)    nom du dépôt ; sinon "Dépôt de la moughataa <Moughataa>"
//   GAS           (obligatoire)  gestionnaire du dépôt -> rôle GAS_MOUGHATAA
//   Telephone GAS, Identifiant GAS      (optionnels)
//   MCM           (optionnel)    médecin chef -> rôle MEDECIN_CHEF_MOUGHATAA
//   Telephone MCM, Identifiant MCM      (optionnels)
//   Si la moughataa a déjà un dépôt SANS aucun compte, l'import rattache les
//   comptes à ce dépôt (rien d'autre n'est créé ni modifié). S'il a déjà des
//   comptes, la ligne est ignorée.
//
// Rattachement : l'application ne rattache un compte qu'à un établissement.
// Le dépôt (GAS_DRS ou GAS_MOUGHATAA) est donc l'établissement qui porte à la
// fois le GAS et le Directeur / le MCM de la zone ; c'est le rôle qui les
// distingue. Une ligne est enregistrée en une seule transaction (structure +
// dépôt + comptes) : si une étape échoue, rien n'est créé pour cette ligne.
// Une ligne en erreur n'empêche jamais les autres.
//
// Réponse : { message, resultats: [{ ligne, nom, region, statut: "ok"|"erreur",
// message, comptes: [{ role, nomComplet, identifiant, motDePasse }] }] }
// Les mots de passe en clair ne sont renvoyés que dans cette réponse.
// ---------------------------------------------------------------------------

const TAILLE_MAX_FICHIER = 5 * 1024 * 1024; // 5 Mo
const LIGNES_MAX = 500;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_FICHIER },
}).single("fichier");

// "Téléphone GAS" / "telephone_gas" -> "telephonegas"
function cle(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Comparaison de noms : sans accents, sans casse, espaces simples.
function nomNormalise(valeur) {
  return String(valeur ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slug(valeur) {
  return nomNormalise(valeur).replace(/ /g, ".");
}

const ALIAS_DRS = {
  region: "region",
  drs: "region",
  nomdrs: "region",
  nom: "region",
  code: "code",
  codedrs: "code",
  depot: "depot",
  nomdepot: "depot",
  nomdudepot: "depot",
  gas: "gas",
  nomgas: "gas",
  gasdrs: "gas",
  gestionnaire: "gas",
  telephonegas: "telGas",
  telgas: "telGas",
  identifiantgas: "idGas",
  directeur: "chef",
  nomdirecteur: "chef",
  telephonedirecteur: "telChef",
  teldirecteur: "telChef",
  identifiantdirecteur: "idChef",
};

const ALIAS_MOUGHATAA = {
  moughataa: "moughataa",
  nom: "moughataa",
  nommoughataa: "moughataa",
  region: "region",
  drs: "region",
  nomdrs: "region",
  depot: "depot",
  nomdepot: "depot",
  nomdudepot: "depot",
  gas: "gas",
  nomgas: "gas",
  gasmoughataa: "gas",
  gestionnaire: "gas",
  telephonegas: "telGas",
  telgas: "telGas",
  identifiantgas: "idGas",
  mcm: "chef",
  nommcm: "chef",
  medecinchef: "chef",
  medecinchefmoughataa: "chef",
  telephonemcm: "telChef",
  telmcm: "telChef",
  identifiantmcm: "idChef",
};

function lireFichier(fichier, alias) {
  const nom = (fichier.originalname || "").toLowerCase();
  let classeur;
  if (nom.endsWith(".csv")) {
    // CSV : séparateur détecté (Excel français exporte souvent en ";").
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
  const entetesTrouvees = new Set();
  const lignes = brut.map((ligneBrute, index) => {
    const ligne = {};
    for (const [entete, valeur] of Object.entries(ligneBrute)) {
      const champ = alias[cle(entete)];
      if (!champ) continue;
      if (index === 0) entetesTrouvees.add(champ);
      // Si deux colonnes désignent le même champ, la première non vide gagne.
      const texte = String(valeur ?? "").trim();
      if (texte || ligne[champ] === undefined) ligne[champ] = texte;
    }
    return ligne;
  });
  return { lignes, entetesTrouvees };
}

// Mot de passe aléatoire de 8 caractères, sans caractères ambigus.
function motDePasseAleatoire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += alphabet[crypto.randomInt(alphabet.length)];
  return mdp;
}

function ajouterDansListe(index, cleNom, valeur) {
  (index[cleNom] = index[cleNom] || []).push(valeur);
}

// Réserve un identifiant : celui fourni (doit être libre) ou généré à partir
// de "base" (suffixe .2, .3... si déjà pris). Renvoie { identifiant } ou
// { erreur }.
function reserverIdentifiant(identifiantsPris, fourni, base) {
  if (fourni) {
    if (/\s/.test(fourni)) return { erreur: `L'identifiant "${fourni}" ne doit pas contenir d'espaces.` };
    if (identifiantsPris.has(fourni.toLowerCase())) return { erreur: `L'identifiant "${fourni}" est déjà utilisé.` };
    return { identifiant: fourni };
  }
  const racine = (base || "compte").slice(0, 40);
  let identifiant = racine;
  let n = 2;
  while (identifiantsPris.has(identifiant.toLowerCase())) {
    identifiant = `${racine}.${n}`;
    n += 1;
  }
  return { identifiant };
}

// ---------------------------------------------------------------------------
// Moteur commun. `config` décrit ce qui change entre les deux imports :
//   alias, colonnesObligatoires, libellesColonnes, nomResultat (champ "nom"),
//   typeDepot, roleGas, roleChef, libelleChef, ligneSuivante(contexte)
// ---------------------------------------------------------------------------
async function traiterImport(req, res, config) {
  if (!req.file) {
    return res.status(400).json({ erreur: "Aucun fichier reçu. Choisis un fichier Excel ou CSV." });
  }

  let lecture;
  try {
    lecture = lireFichier(req.file, config.alias);
  } catch (err) {
    return res.status(400).json({ erreur: "Fichier illisible : vérifie qu'il s'agit bien d'un Excel (.xlsx) ou d'un CSV." });
  }
  if (lecture.erreur) return res.status(400).json({ erreur: lecture.erreur });

  const manquantes = config.colonnesObligatoires.filter((c) => !lecture.entetesTrouvees.has(c));
  if (manquantes.length > 0) {
    return res.status(400).json({
      erreur: `Colonne(s) manquante(s) dans la première ligne du fichier : ${manquantes
        .map((c) => config.libellesColonnes[c])
        .join(", ")}.`,
    });
  }

  const { lignes } = lecture;
  if (lignes.length === 0) {
    return res.status(400).json({ erreur: "Le fichier ne contient aucune ligne de données." });
  }
  if (lignes.length > LIGNES_MAX) {
    return res.status(400).json({ erreur: `Trop de lignes (${lignes.length}). Maximum ${LIGNES_MAX} par import.` });
  }

  const contexte = await config.charger();
  const identifiantsPris = new Set(
    (await prisma.utilisateur.findMany({ select: { identifiant: true } })).map((u) => u.identifiant.toLowerCase())
  );

  const resultats = [];

  for (let i = 0; i < lignes.length; i++) {
    const numeroLigne = i + 2; // +1 en-tête, +1 car Excel compte depuis 1
    const l = lignes[i];

    // Ligne entièrement vide : ignorée sans bruit.
    if (Object.values(l).every((v) => !v)) continue;

    const base = { ligne: numeroLigne, nom: l[config.champNom] || "", region: l.region || "" };
    const erreur = (message) => resultats.push({ ...base, statut: "erreur", message, comptes: [] });

    // --- Validation des champs de la ligne ---
    const manque = config.colonnesObligatoires.find((c) => !l[c]);
    if (manque) {
      erreur(`${config.libellesColonnes[manque]} manquant(e).`);
      continue;
    }
    if (!l.gas) {
      erreur("Nom du GAS (gestionnaire du dépôt) manquant.");
      continue;
    }
    if (!l.chef && (l.telChef || l.idChef)) {
      erreur(`Téléphone ou identifiant du ${config.libelleChef} renseigné sans son nom.`);
      continue;
    }

    // --- Règles propres à chaque import (structure existante, doublons) ---
    const plan = config.planifier(contexte, l);
    if (plan.erreur) {
      erreur(plan.erreur);
      continue;
    }

    // --- Identifiants des comptes ---
    const comptes = [];
    const demandes = [
      { role: config.roleGas, nomComplet: l.gas, telephone: l.telGas, fourni: l.idGas, base: `${config.prefixeGas}.${plan.slugZone}` },
    ];
    if (l.chef) {
      demandes.push({
        role: config.roleChef,
        nomComplet: l.chef,
        telephone: l.telChef,
        fourni: l.idChef,
        base: `${config.prefixeChef}.${plan.slugZone}`,
      });
    }
    if (l.idGas && l.idChef && l.idGas.toLowerCase() === l.idChef.toLowerCase()) {
      erreur("Le GAS et le " + config.libelleChef + " ne peuvent pas avoir le même identifiant.");
      continue;
    }

    const reserves = []; // pour libérer si une erreur survient en cours de route
    let echec = null;
    for (const d of demandes) {
      const r = reserverIdentifiant(identifiantsPris, d.fourni, d.base);
      if (r.erreur) {
        echec = r.erreur;
        break;
      }
      identifiantsPris.add(r.identifiant.toLowerCase()); // évite un doublon dans la même ligne
      reserves.push(r.identifiant.toLowerCase());
      comptes.push({
        role: d.role,
        nomComplet: d.nomComplet,
        telephone: d.telephone || null,
        identifiant: r.identifiant,
        motDePasse: motDePasseAleatoire(),
      });
    }
    if (echec) {
      for (const id of reserves) identifiantsPris.delete(id);
      erreur(echec);
      continue;
    }

    // --- Création, en une transaction ---
    try {
      for (const c of comptes) c.motDePasseHash = await hashPassword(c.motDePasse);

      const cree = await prisma.$transaction(async (tx) => {
        const resultatStructure = await plan.creer(tx);
        for (const c of comptes) {
          const utilisateur = await tx.utilisateur.create({
            data: {
              nomComplet: c.nomComplet,
              identifiant: c.identifiant,
              motDePasseHash: c.motDePasseHash,
              telephone: c.telephone,
              estAdminSysteme: false,
            },
          });
          await tx.userEtablissement.create({
            data: { utilisateurId: utilisateur.id, etablissementId: resultatStructure.depotId, role: c.role },
          });
        }
        return resultatStructure;
      });

      plan.apresSucces(contexte, cree);
      resultats.push({
        ...base,
        statut: "ok",
        message: plan.messageOk,
        comptes: comptes.map((c) => ({
          role: c.role,
          nomComplet: c.nomComplet,
          identifiant: c.identifiant,
          motDePasse: c.motDePasse,
        })),
      });
    } catch (err) {
      for (const id of reserves) identifiantsPris.delete(id);
      console.error(`${config.libelleImport}, ligne ${numeroLigne} :`, err);
      const message =
        err.code === "P2002"
          ? "Code ou identifiant déjà utilisé."
          : "Erreur inattendue lors de la création (ligne ignorée, rien n'a été enregistré pour elle).";
      erreur(message);
    }
  }

  const nbOk = resultats.filter((r) => r.statut === "ok").length;
  const nbErreur = resultats.length - nbOk;
  return res.json({
    message: `Import terminé : ${nbOk} ligne(s) créée(s), ${nbErreur} ligne(s) en erreur.`,
    resultats,
  });
}

// ---------------------------------------------------------------------------
// Import DRS
// ---------------------------------------------------------------------------
const CONFIG_DRS = {
  libelleImport: "Import DRS",
  alias: ALIAS_DRS,
  champNom: "region",
  colonnesObligatoires: ["region", "gas"],
  libellesColonnes: { region: "Region", gas: "GAS", code: "Code" },
  roleGas: "GESTIONNAIRE_DRS",
  roleChef: "DIRECTEUR_DRS",
  libelleChef: "Directeur",
  prefixeGas: "gas.drs",
  prefixeChef: "directeur.drs",

  async charger() {
    const drs = await prisma.drs.findMany({ select: { id: true, nom: true, code: true } });
    const depots = await prisma.etablissement.findMany({
      where: { type: "GAS_DRS" },
      select: { nom: true, drsId: true },
    });
    const parNom = {};
    const codes = new Set();
    for (const d of drs) {
      ajouterDansListe(parNom, nomNormalise(d.nom), d);
      codes.add(String(d.code).toLowerCase());
    }
    return { parNom, codes, drsAvecDepot: new Map(depots.map((e) => [e.drsId, e.nom])) };
  },

  planifier(ctx, l) {
    const candidates = ctx.parNom[nomNormalise(l.region)] || [];
    if (candidates.length > 1) {
      return { erreur: `Plusieurs DRS portent le nom "${l.region}" : impossible de choisir automatiquement.` };
    }
    const existante = candidates[0] || null;
    if (existante && ctx.drsAvecDepot.has(existante.id)) {
      return { erreur: `La DRS "${existante.nom}" a déjà son dépôt ("${ctx.drsAvecDepot.get(existante.id)}") : ignorée.` };
    }
    if (!existante) {
      if (!l.code) return { erreur: "Code de la DRS manquant (obligatoire pour créer une nouvelle DRS)." };
      if (ctx.codes.has(l.code.toLowerCase())) return { erreur: `Le code "${l.code}" est déjà utilisé par une autre DRS.` };
    }
    const nomDepot = l.depot || `Dépôt de la DRS ${existante ? existante.nom : l.region}`;
    const nomRegion = existante ? existante.nom : l.region;
    return {
      slugZone: slug(nomRegion),
      messageOk: existante
        ? `DRS existante complétée : dépôt "${nomDepot}" et comptes créés.`
        : `DRS créée avec son dépôt "${nomDepot}" et ses comptes.`,
      async creer(tx) {
        const drs = existante || (await tx.drs.create({ data: { nom: l.region, code: l.code } }));
        const depot = await tx.etablissement.create({
          data: { nom: nomDepot, type: "GAS_DRS", aStockPhysique: true, drsId: drs.id },
        });
        return { drs, depotId: depot.id, nouvelle: !existante };
      },
      apresSucces(contexte, cree) {
        ctx.drsAvecDepot.set(cree.drs.id, nomDepot);
        if (cree.nouvelle) {
          ajouterDansListe(ctx.parNom, nomNormalise(cree.drs.nom), cree.drs);
          ctx.codes.add(String(cree.drs.code).toLowerCase());
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Import Moughataa
// ---------------------------------------------------------------------------
const CONFIG_MOUGHATAA = {
  libelleImport: "Import Moughataa",
  alias: ALIAS_MOUGHATAA,
  champNom: "moughataa",
  colonnesObligatoires: ["moughataa", "region", "gas"],
  libellesColonnes: { moughataa: "Moughataa", region: "Region", gas: "GAS" },
  roleGas: "GAS_MOUGHATAA",
  roleChef: "MEDECIN_CHEF_MOUGHATAA",
  libelleChef: "MCM",
  prefixeGas: "gas",
  prefixeChef: "mcm",

  async charger() {
    const drs = await prisma.drs.findMany({ select: { id: true, nom: true } });
    const moughataas = await prisma.moughataa.findMany({
      select: { id: true, nom: true, drsId: true, drs: { select: { nom: true } } },
    });
    const depots = await prisma.etablissement.findMany({
      where: { type: "GAS_MOUGHATAA" },
      select: { id: true, nom: true, moughataaId: true, _count: { select: { userEtablissements: true } } },
    });
    const depotsParMoughataa = new Map();
    for (const e of depots) {
      if (!e.moughataaId) continue;
      const liste = depotsParMoughataa.get(e.moughataaId) || [];
      liste.push({ id: e.id, nom: e.nom, nbComptes: e._count.userEtablissements });
      depotsParMoughataa.set(e.moughataaId, liste);
    }
    const drsParNom = {};
    for (const d of drs) ajouterDansListe(drsParNom, nomNormalise(d.nom), d);
    const moughataasParNom = {};
    for (const m of moughataas) ajouterDansListe(moughataasParNom, nomNormalise(m.nom), m);
    return {
      drsParNom,
      moughataasParNom,
      depotsParMoughataa,
    };
  },

  planifier(ctx, l) {
    const drsCandidates = ctx.drsParNom[nomNormalise(l.region)] || [];
    if (drsCandidates.length === 0) {
      return { erreur: `Region "${l.region}" introuvable : crée-la d'abord (import DRS ou onglet Régions), ou corrige l'orthographe.` };
    }
    if (drsCandidates.length > 1) {
      return { erreur: `Plusieurs DRS portent le nom "${l.region}" : impossible de choisir automatiquement.` };
    }
    const drs = drsCandidates[0];

    const memeNom = ctx.moughataasParNom[nomNormalise(l.moughataa)] || [];
    const dansCetteDrs = memeNom.filter((m) => m.drsId === drs.id);
    if (dansCetteDrs.length === 0 && memeNom.length > 0) {
      const ailleurs = memeNom.map((m) => m.drs?.nom || "?").join(", ");
      return {
        erreur: `La moughataa "${l.moughataa}" existe déjà dans une autre région (${ailleurs}) : ignorée. Corrige son rattachement dans l'onglet Régions si elle est mal placée.`,
      };
    }
    if (dansCetteDrs.length > 1) {
      return { erreur: `Plusieurs moughataa "${l.moughataa}" existent dans la région ${drs.nom} : impossible de choisir.` };
    }
    const existante = dansCetteDrs[0] || null;

    // Moughataa qui a déjà un dépôt : si ce dépôt n'a encore AUCUN compte, on
    // y rattache les comptes (GAS, MCM) sans rien créer ni modifier d'autre.
    // S'il a déjà des comptes, ou s'il y a plusieurs dépôts, on ne touche à rien.
    const depotsExistants = existante ? ctx.depotsParMoughataa.get(existante.id) || [] : [];
    if (depotsExistants.length > 1) {
      return {
        erreur: `La moughataa "${existante.nom}" a plusieurs dépôts (${depotsExistants.map((d) => `"${d.nom}"`).join(", ")}) : ignorée, à traiter à la main.`,
      };
    }
    const depotExistant = depotsExistants[0] || null;
    if (depotExistant && depotExistant.nbComptes > 0) {
      return {
        erreur: `La moughataa "${existante.nom}" a déjà son dépôt ("${depotExistant.nom}") avec ${depotExistant.nbComptes} compte(s) rattaché(s) : ignorée.`,
      };
    }

    const nomMoughataa = existante ? existante.nom : l.moughataa;
    const nomDepot = depotExistant ? depotExistant.nom : l.depot || `Dépôt de la moughataa ${nomMoughataa}`;
    return {
      slugZone: slug(nomMoughataa),
      messageOk: depotExistant
        ? `Dépôt existant "${nomDepot}" complété : comptes créés et rattachés (aucune autre donnée modifiée).`
        : existante
        ? `Moughataa existante complétée : dépôt "${nomDepot}" et comptes créés.`
        : `Moughataa créée (région ${drs.nom}) avec son dépôt "${nomDepot}" et ses comptes.`,
      async creer(tx) {
        if (depotExistant) {
          return { moughataa: existante, depotId: depotExistant.id, nouvelle: false, depotCree: false };
        }
        const moughataa = existante || (await tx.moughataa.create({ data: { nom: l.moughataa, drsId: drs.id } }));
        // drsId renseigné : c'est ce que le code du stock réseau utilise pour
        // que la DRS retrouve les dépôts de ses moughataa.
        const depot = await tx.etablissement.create({
          data: {
            nom: nomDepot,
            type: "GAS_MOUGHATAA",
            aStockPhysique: true,
            moughataaId: moughataa.id,
            drsId: drs.id,
          },
        });
        return { moughataa, depotId: depot.id, nouvelle: !existante, depotCree: true };
      },
      apresSucces(contexte, cree) {
        const liste = ctx.depotsParMoughataa.get(cree.moughataa.id) || [];
        if (cree.depotCree) liste.push({ id: cree.depotId, nom: nomDepot, nbComptes: 1 });
        else if (liste[0]) liste[0].nbComptes = 1;
        ctx.depotsParMoughataa.set(cree.moughataa.id, liste);
        if (cree.nouvelle) {
          ajouterDansListe(ctx.moughataasParNom, nomNormalise(cree.moughataa.nom), {
            id: cree.moughataa.id,
            nom: cree.moughataa.nom,
            drsId: drs.id,
            drs: { nom: drs.nom },
          });
        }
      },
    };
  },
};

// Enveloppe multer : erreur JSON claire (fichier trop gros, mauvais champ...)
// plutôt que la page d'erreur HTML par défaut d'Express.
function avecUpload(config) {
  return function (req, res, next) {
    upload(req, res, (err) => {
      if (err) {
        const message =
          err.code === "LIMIT_FILE_SIZE"
            ? "Fichier trop volumineux (5 Mo maximum)."
            : "Le fichier n'a pas pu être reçu. Réessaie.";
        return res.status(400).json({ erreur: message });
      }
      traiterImport(req, res, config).catch(next);
    });
  };
}

// POST /admin/drs/import
const importerDrs = avecUpload(CONFIG_DRS);
// POST /admin/moughataa/import
const importerMoughataa = avecUpload(CONFIG_MOUGHATAA);

module.exports = { importerDrs, importerMoughataa };