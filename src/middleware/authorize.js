// Autorise l'accès uniquement aux rôles listés.
// Usage : router.get("/route", authentifier, autoriser("ADMIN", "AUDITEUR"), controleur)
function autoriser(...rolesAutorises) {
  return (req, res, next) => {
    if (!req.utilisateur) {
      return res.status(401).json({ erreur: "Authentification requise." });
    }

    if (!rolesAutorises.includes(req.utilisateur.role)) {
      return res.status(403).json({ erreur: "Ton rôle ne permet pas d'accéder à cette ressource." });
    }

    next();
  };
}

module.exports = { autoriser };
