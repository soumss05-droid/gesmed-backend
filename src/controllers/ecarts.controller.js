const prisma = require("../config/prisma");

// GET /ecarts/en-attente
// Réservé aux rôles GAS_PROGRAMME_NATIONAL et AUDITEUR (vérifié par le middleware autoriser).
async function listerEcartsEnAttente(req, res) {
  const ecarts = await prisma.blLigne.findMany({
    where: { ecartStatut: "EN_ATTENTE" },
    include: {
      produit: true,
      lot: true,
      bl: { include: { etablissementDestinataire: true, etablissementExpediteur: true } },
    },
  });

  return res.json(ecarts);
}

// POST /ecarts/:blLigneId/decision
// Body : { decision: "debloquer" | "maintenir", motif }
// Pas de seuil chiffré : la décision reste au jugement du GAS Programme national ou de l'Auditeur.
async function traiterEcart(req, res) {
  const { utilisateurId } = req.utilisateur;
  const { blLigneId } = req.params;
  const { decision, motif } = req.body;

  if (!motif || !motif.trim()) {
    return res.status(400).json({ erreur: "Un motif est obligatoire pour trancher un écart." });
  }

  const ligne = await prisma.blLigne.findUnique({
    where: { id: blLigneId },
    include: { bl: true, lot: true },
  });

  if (!ligne || ligne.ecartStatut !== "EN_ATTENTE") {
    return res.status(404).json({ erreur: "Écart introuvable ou déjà traité." });
  }

  if (decision === "maintenir") {
    const misAJour = await prisma.blLigne.update({
      where: { id: blLigneId },
      data: { ecartStatut: "MAINTENU", ecartDecideurId: utilisateurId, ecartMotif: motif.trim() },
    });
    return res.json(misAJour);
  }

  if (decision === "debloquer") {
    const etablissementId = ligne.bl.etablissementDestinataireId;

    // Débloquer met à jour le stock du destinataire avec la quantité
    // réellement reçue, en reprenant le vrai numéro de lot et la vraie date
    // de péremption du lot d'origine expédié.
    await prisma.stock.upsert({
      where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
      update: { quantiteTotale: { increment: ligne.quantiteRecue } },
      create: {
        produitId: ligne.produitId,
        etablissementId,
        quantiteTotale: ligne.quantiteRecue,
        seuilMin: 0,
        seuilMax: 0,
      },
    });

    const nouveauLot = await prisma.lot.create({
      data: {
        produitId: ligne.produitId,
        etablissementId,
        numeroLot: ligne.lot.numeroLot,
        datePeremption: ligne.lot.datePeremption,
        quantite: ligne.quantiteRecue,
      },
    });

    await prisma.mouvementStock.create({
      data: {
        lotId: nouveauLot.id,
        type: "ENTREE",
        quantite: ligne.quantiteRecue,
        referenceType: "BL",
        referenceId: ligne.bl.id,
        utilisateurId,
      },
    });

    const misAJour = await prisma.blLigne.update({
      where: { id: blLigneId },
      data: { ecartStatut: "DEBLOQUE", ecartDecideurId: utilisateurId, ecartMotif: motif.trim() },
    });

    return res.json(misAJour);
  }

  return res.status(400).json({ erreur: "Décision non reconnue." });
}

module.exports = { listerEcartsEnAttente, traiterEcart };