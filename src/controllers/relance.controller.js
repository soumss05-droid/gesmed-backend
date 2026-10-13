const prisma = require("../config/prisma");

const DELAI_AVANT_RELANCE_HEURES = 48;

// POST /requisitions/:id/relancer
// Relance le niveau qui doit traiter une réquisition restée EN_ATTENTE.
// Règles : seul le demandeur (ou le demandeur de la réquisition parente)
// peut relancer ; la réquisition doit être EN_ATTENTE depuis au moins
// 48 h ; une seule relance toutes les 48 h par réquisition.
async function relancerRequisition(req, res) {
  try {
    const { etablissementId } = req.utilisateur;
    const { id } = req.params;

    if (!etablissementId) {
      return res.status(403).json({ erreur: "Seul un établissement peut relancer une réquisition." });
    }

    const requisition = await prisma.requisition.findUnique({
      where: { id },
      include: {
        etablissementDemandeur: { select: { nom: true } },
        niveauActuel: { select: { nom: true } },
        requisitionParent: { select: { etablissementDemandeurId: true } },
      },
    });

    if (!requisition) {
      return res.status(404).json({ erreur: "Réquisition introuvable." });
    }

    const estDemandeur =
      requisition.etablissementDemandeurId === etablissementId ||
      requisition.requisitionParent?.etablissementDemandeurId === etablissementId;

    if (!estDemandeur) {
      return res.status(403).json({ erreur: "Vous ne pouvez relancer que vos propres réquisitions." });
    }

    if (requisition.statut !== "EN_ATTENTE") {
      return res.status(409).json({ erreur: "Seule une réquisition en attente peut être relancée." });
    }

    const heures =
      (Date.now() - new Date(requisition.dateDerniereMaj || requisition.dateCreation).getTime()) /
      (1000 * 60 * 60);

    if (heures < DELAI_AVANT_RELANCE_HEURES) {
      return res.status(409).json({
        erreur: `Une relance n'est possible qu'après ${DELAI_AVANT_RELANCE_HEURES} heures d'attente.`,
      });
    }

    const limite = new Date(Date.now() - DELAI_AVANT_RELANCE_HEURES * 60 * 60 * 1000);
    const dejaRelancee = await prisma.notification.findFirst({
      where: { requisitionId: id, type: "RELANCE", createdAt: { gte: limite } },
    });

    if (dejaRelancee) {
      return res.status(409).json({
        erreur: `Une relance a déjà été envoyée il y a moins de ${DELAI_AVANT_RELANCE_HEURES} heures.`,
      });
    }

    const jours = Math.max(1, Math.floor(heures / 24));
    await prisma.notification.create({
      data: {
        etablissementId: requisition.niveauActuelId,
        etablissementAuteurId: etablissementId,
        type: "RELANCE",
        message: `Relance : la réquisition N°${requisition.numero} de ${requisition.etablissementDemandeur.nom} attend votre traitement depuis ${jours} jour(s).`,
        requisitionId: requisition.id,
      },
    });

    return res.json({ message: "Relance envoyée." });
  } catch (erreur) {
    console.error("Erreur lors de la relance d'une réquisition :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de la relance." });
  }
}

module.exports = { relancerRequisition };