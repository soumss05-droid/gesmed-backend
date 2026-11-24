const prisma = require("../config/prisma");

// Marge de bénéfice appliquée à la dispensation, réglée par l'administrateur.
// Clés dans parametres_systeme :
//   marge_pourcent        = marge par défaut (niveau non renseigné ou sans marge propre)
//   marge_<NIVEAU>        = marge propre à un niveau de formation sanitaire
const NIVEAUX = [
  { code: "HOPITAL", libelle: "Hôpital" },
  { code: "CS_MOUGHATAA", libelle: "Centre de santé de moughataa" },
  { code: "CS_SECONDAIRE", libelle: "Centre de santé secondaire" },
  { code: "PS_PRINCIPAL", libelle: "Poste de santé principal" },
  { code: "PS_SECONDAIRE", libelle: "Poste de santé secondaire" },
  { code: "UPEC_COMMUNAUTAIRE", libelle: "UPEC communautaire" },
  { code: "AUTRE", libelle: "Autre (cabinets, cliniques)" },
];

const MARGE_MAX = 1000;

function lireValeur(param) {
  if (!param) return null;
  if (String(param.valeur).trim() === "") return null;
  const n = Number(param.valeur);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// GET /admin/marges
async function lireMarges(req, res) {
  try {
    const cles = ["marge_pourcent", ...NIVEAUX.map((n) => "marge_" + n.code)];
    const params = await prisma.parametreSysteme.findMany({ where: { cle: { in: cles } } });
    const parCle = new Map(params.map((p) => [p.cle, p]));

    const defaut = lireValeur(parCle.get("marge_pourcent"));
    const niveaux = NIVEAUX.map((n) => ({
      niveau: n.code,
      libelle: n.libelle,
      marge: lireValeur(parCle.get("marge_" + n.code)),
    }));

    return res.json({ defaut: defaut === null ? 0 : defaut, niveaux });
  } catch (e) {
    console.error("lireMarges :", e);
    return res.status(500).json({ erreur: "Erreur serveur lors de la lecture des marges." });
  }
}

// PUT /admin/marges
// Body : { defaut: nombre >= 0, niveaux: { HOPITAL: nombre | "" | null, ... } }
// Une valeur vide efface la marge propre du niveau (il retombe sur la marge par défaut).
async function enregistrerMarges(req, res) {
  try {
    const { defaut, niveaux } = req.body || {};

    const verifier = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= MARGE_MAX ? n : null;
    };

    if (defaut === undefined || defaut === null || String(defaut).trim() === "") {
      return res.status(400).json({ erreur: "La marge par défaut est obligatoire (0 si aucune marge)." });
    }
    const defautNombre = verifier(defaut);
    if (defautNombre === null) {
      return res.status(400).json({ erreur: `La marge par défaut doit être un nombre entre 0 et ${MARGE_MAX}.` });
    }

    const operations = [];
    const utilisateurId = req.utilisateur.utilisateurId;
    const maintenant = new Date();

    operations.push(
      prisma.parametreSysteme.upsert({
        where: { cle: "marge_pourcent" },
        update: { valeur: String(defautNombre), misAJourPar: utilisateurId, dateMiseAJour: maintenant },
        create: { cle: "marge_pourcent", valeur: String(defautNombre), misAJourPar: utilisateurId, dateMiseAJour: maintenant },
      })
    );

    const saisie = niveaux && typeof niveaux === "object" ? niveaux : {};
    for (const n of NIVEAUX) {
      if (!(n.code in saisie)) continue; // niveau non transmis : on ne touche pas
      const v = saisie[n.code];
      const cle = "marge_" + n.code;

      if (v === null || v === undefined || String(v).trim() === "") {
        operations.push(prisma.parametreSysteme.deleteMany({ where: { cle } }));
        continue;
      }
      const nombre = verifier(v);
      if (nombre === null) {
        return res
          .status(400)
          .json({ erreur: `La marge « ${n.libelle} » doit être un nombre entre 0 et ${MARGE_MAX} (ou vide).` });
      }
      operations.push(
        prisma.parametreSysteme.upsert({
          where: { cle },
          update: { valeur: String(nombre), misAJourPar: utilisateurId, dateMiseAJour: maintenant },
          create: { cle, valeur: String(nombre), misAJourPar: utilisateurId, dateMiseAJour: maintenant },
        })
      );
    }

    await prisma.$transaction(operations);
    return lireMarges(req, res);
  } catch (e) {
    console.error("enregistrerMarges :", e);
    return res.status(500).json({ erreur: "Erreur serveur lors de l'enregistrement des marges." });
  }
}

module.exports = { lireMarges, enregistrerMarges };