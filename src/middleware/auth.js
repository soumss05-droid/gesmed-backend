const jwt = require("jsonwebtoken");

function authentifier(req, res, next) {
  const enTete = req.headers.authorization;

  if (!enTete || !enTete.startsWith("Bearer ")) {
    return res.status(401).json({ erreur: "Authentification requise." });
  }

  const token = enTete.split(" ")[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // payload attendu : { utilisateurId, etablissementId, role }
    req.utilisateur = payload;
    next();
  } catch (erreur) {
    return res.status(401).json({ erreur: "Session invalide ou expirée, reconnecte-toi." });
  }
}

module.exports = { authentifier };
