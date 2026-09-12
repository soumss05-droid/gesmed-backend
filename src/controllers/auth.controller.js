const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const { comparePassword } = require("../utils/hash");

// POST /auth/login
// Body attendu : { identifiant, motDePasse, etablissementId }
// etablissementId est nécessaire car un utilisateur peut avoir plusieurs
// rôles selon l'établissement auquel il se connecte.
async function login(req, res) {
  const { identifiant, motDePasse, etablissementId } = req.body;

  if (!identifiant || !motDePasse) {
    return res.status(400).json({ erreur: "Identifiant et mot de passe requis." });
  }

  const utilisateur = await prisma.utilisateur.findUnique({
    where: { identifiant },
    include: { etablissements: { include: { etablissement: true } } },
  });

  if (!utilisateur || !utilisateur.actif) {
    return res.status(401).json({ erreur: "Identifiant ou mot de passe incorrect." });
  }

  const motDePasseValide = await comparePassword(motDePasse, utilisateur.motDePasseHash);
  if (!motDePasseValide) {
    return res.status(401).json({ erreur: "Identifiant ou mot de passe incorrect." });
  }

  // Cas particulier : l'Admin système n'est rattaché à aucun établissement.
  // Il a accès à toute la situation nationale et gère les comptes/rôles.
  // On le connecte directement, sans passer par la logique de rattachement.
  if (utilisateur.estAdminSysteme) {
    const token = jwt.sign(
      { utilisateurId: utilisateur.id, role: "ADMIN" },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      token,
      utilisateur: {
        id: utilisateur.id,
        nomComplet: utilisateur.nomComplet,
        role: "ADMIN",
        etablissement: null,
      },
    });
  }

  const rattachementsActifs = utilisateur.etablissements.filter((r) => r.actif);

  if (rattachementsActifs.length === 0) {
    return res.status(403).json({ erreur: "Aucun établissement actif rattaché à ce compte." });
  }

  // Si l'utilisateur n'a qu'un seul rattachement, on le connecte directement.
  // S'il en a plusieurs, le frontend doit lui proposer de choisir (etablissementId requis).
  let rattachement;
  if (rattachementsActifs.length === 1) {
    rattachement = rattachementsActifs[0];
  } else {
    if (!etablissementId) {
      return res.status(200).json({
        choixEtablissementRequis: true,
        etablissements: rattachementsActifs.map((r) => ({
          id: r.etablissement.id,
          nom: r.etablissement.nom,
          role: r.role,
        })),
      });
    }
    rattachement = rattachementsActifs.find((r) => r.etablissementId === etablissementId);
    if (!rattachement) {
      return res.status(403).json({ erreur: "Rattachement introuvable pour cet établissement." });
    }
  }

  const token = jwt.sign(
    {
      utilisateurId: utilisateur.id,
      etablissementId: rattachement.etablissementId,
      role: rattachement.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  return res.json({
    token,
    utilisateur: {
      id: utilisateur.id,
      nomComplet: utilisateur.nomComplet,
      role: rattachement.role,
      etablissement: rattachement.etablissement.nom,
    },
  });
}

module.exports = { login };