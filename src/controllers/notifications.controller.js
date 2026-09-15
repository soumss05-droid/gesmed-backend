const prisma = require("../config/prisma");

// GET /notifications
// Liste les notifications de l'établissement de l'utilisateur connecté, les
// plus récentes en premier. N'affecte jamais le circuit métier lui-même —
// purement informatif.
async function listerNotifications(req, res) {
  const { etablissementId } = req.utilisateur;

  const notifications = await prisma.notification.findMany({
    where: { etablissementId },
    orderBy: { createdAt: "desc" },
    include: {
      requisition: { select: { id: true, statut: true } },
      produit: { select: { id: true, nom: true } },
    },
    take: 100,
  });

  return res.json(notifications);
}

// POST /notifications/:id/lue
// Marque une notification comme lue.
async function marquerLue(req, res) {
  const { etablissementId } = req.utilisateur;
  const { id } = req.params;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.etablissementId !== etablissementId) {
    return res.status(404).json({ erreur: "Notification introuvable." });
  }

  const misAJour = await prisma.notification.update({
    where: { id },
    data: { lue: true },
  });

  return res.json(misAJour);
}

module.exports = { listerNotifications, marquerLue };