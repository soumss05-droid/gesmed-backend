const prisma = require("../config/prisma");
const { comparePassword, hashPassword } = require("../utils/hash");

// POST /auth/changer-mot-de-passe  (utilisateur connecté, tous rôles)
// Body : { ancienMotDePasse, nouveauMotDePasse }
// Ne modifie QUE le compte de la personne connectée (id lu dans le jeton).
async function changerMotDePasse(req, res) {
  try {
    const { utilisateurId } = req.utilisateur;
    const { ancienMotDePasse, nouveauMotDePasse } = req.body || {};

    if (!ancienMotDePasse || !nouveauMotDePasse) {
      return res.status(400).json({ erreur: "Ancien et nouveau mot de passe requis." });
    }
    if (String(nouveauMotDePasse).length < 8) {
      return res.status(400).json({ erreur: "Le nouveau mot de passe doit contenir au moins 8 caractères." });
    }
    if (nouveauMotDePasse === ancienMotDePasse) {
      return res.status(400).json({ erreur: "Le nouveau mot de passe doit être différent de l'ancien." });
    }

    const utilisateur = await prisma.utilisateur.findUnique({ where: { id: utilisateurId } });
    if (!utilisateur || !utilisateur.actif) {
      return res.status(401).json({ erreur: "Compte introuvable ou désactivé." });
    }

    const ancienValide = await comparePassword(ancienMotDePasse, utilisateur.motDePasseHash);
    if (!ancienValide) {
      return res.status(401).json({ erreur: "L'ancien mot de passe est incorrect." });
    }

    const motDePasseHash = await hashPassword(nouveauMotDePasse);
    await prisma.utilisateur.update({
      where: { id: utilisateurId },
      data: { motDePasseHash },
    });

    return res.json({ message: "Mot de passe modifié." });
  } catch (err) {
    console.error("Changement de mot de passe :", err);
    return res.status(500).json({ erreur: "Erreur inattendue, réessayez." });
  }
}

module.exports = { changerMotDePasse };