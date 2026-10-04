const prisma = require("../config/prisma");
const { recalculerStatutStock, creerOuIncrementerLot } = require("./stocks.controller");

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
// Body : { decision: "debloquer" | "maintenir", motif, compensationRequise }
// Pas de seuil chiffré : la décision reste au jugement du GAS Programme national ou de l'Auditeur.
// "compensationRequise" n'est pris en compte que si "maintenir" est choisi sur un vrai manque
// (quantiteEnvoyee > quantiteRecue) : il détermine si on notifie l'expéditeur pour qu'il
// compense (ECART_A_COMPENSER) ou si on se contente d'enregistrer la perte en transit
// (PerteTransit), sans la faire remonter.
async function traiterEcart(req, res) {
  const { utilisateurId } = req.utilisateur;
  const { blLigneId } = req.params;
  const { decision, motif, compensationRequise } = req.body;

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
    const quantiteRecue = ligne.quantiteRecue ?? 0;
    const ecartReel = ligne.quantiteEnvoyee - quantiteRecue;
    const estUnManqueReel = ecartReel > 0;
    const compensationDemandee = estUnManqueReel && Boolean(compensationRequise);

    const misAJour = await prisma.blLigne.update({
      where: { id: blLigneId },
      data: {
        ecartStatut: "MAINTENU",
        ecartDecideurId: utilisateurId,
        ecartMotif: motif.trim(),
        compensationRequise: compensationDemandee,
      },
    });

    if (estUnManqueReel) {
      if (compensationDemandee) {
        await prisma.notification.create({
          data: {
            etablissementId: ligne.bl.etablissementExpediteurId,
            etablissementAuteurId: ligne.bl.etablissementDestinataireId,
            type: "ECART_A_COMPENSER",
            message: `Écart maintenu sur le BL n°${ligne.bl.numero} : ${ecartReel} unité(s) à compenser (motif : ${motif.trim()}).`,
            produitId: ligne.produitId,
          },
        });
      } else {
        await prisma.perteTransit.create({
          data: {
            blLigneId: ligne.id,
            produitId: ligne.produitId,
            etablissementExpediteurId: ligne.bl.etablissementExpediteurId,
            etablissementDestinataireId: ligne.bl.etablissementDestinataireId,
            quantitePerdue: ecartReel,
          },
        });
      }
    }

    return res.json(misAJour);
  }

  if (decision === "debloquer") {
    const etablissementId = ligne.bl.etablissementDestinataireId;

    // Débloquer met à jour le stock du destinataire avec la quantité
    // réellement reçue, en reprenant le vrai numéro de lot et la vraie date
    // de péremption du lot d'origine expédié.
    const stockExistant = await prisma.stock.findUnique({
      where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
    });

    if (stockExistant) {
      await prisma.stock.update({
        where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
        data: { quantiteTotale: { increment: ligne.quantiteRecue } },
      });
    } else {
      const produit = await prisma.produit.findUnique({ where: { id: ligne.produitId } });
      await prisma.stock.create({
        data: {
          produitId: ligne.produitId,
          etablissementId,
          quantiteTotale: ligne.quantiteRecue,
          seuilMin: produit?.seuilMinDefaut ?? 0,
          seuilMax: produit?.seuilMaxDefaut ?? 0,
          statut: "RUPTURE", // recalculé juste en dessous, valeur de départ neutre
        },
      });
    }
    // Le statut n'est jamais recalculé automatiquement par Prisma : sans cet
    // appel, un stock resterait affiché "Rupture" même après un déblocage
    // qui le remonte largement au-dessus du seuil.
    await recalculerStatutStock(ligne.produitId, etablissementId);

    const nouveauLot = await creerOuIncrementerLot({
      produitId: ligne.produitId,
      etablissementId,
      numeroLot: ligne.lot.numeroLot,
      datePeremption: ligne.lot.datePeremption,
      quantite: ligne.quantiteRecue,
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