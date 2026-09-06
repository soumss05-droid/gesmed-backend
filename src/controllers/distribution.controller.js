const prisma = require("../config/prisma");
const { selectionnerLotFEFO } = require("./stocks.controller");

// GET /distribution/pretes
// Réquisitions validées, prêtes à être expédiées par l'établissement connecté (CAMEC ou GAS DRS).
async function listerPretesAExpedier(req, res) {
  const { etablissementId } = req.utilisateur;

  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etablissementId, statut: "VALIDEE" },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
  });

  return res.json(requisitions);
}

// POST /distribution/:requisitionId/generer-bl
// Génère un bordereau de livraison pour une réquisition validée,
// en sélectionnant les lots à expédier selon la logique FEFO.
async function genererBl(req, res) {
  const { etablissementId } = req.utilisateur;
  const { requisitionId } = req.params;

  const requisition = await prisma.requisition.findUnique({
    where: { id: requisitionId },
    include: { lignes: true },
  });

  if (!requisition || requisition.niveauActuelId !== etablissementId || requisition.statut !== "VALIDEE") {
    return res.status(404).json({ erreur: "Réquisition introuvable ou non prête à expédier." });
  }

  const lignesBl = [];

  for (const ligne of requisition.lignes) {
    const { lotsChoisis, quantiteNonCouverte } = await selectionnerLotFEFO(
      ligne.produitId,
      etablissementId,
      ligne.quantiteValidee
    );

    if (quantiteNonCouverte > 0) {
      return res.status(400).json({
        erreur: `Stock insuffisant pour le produit ${ligne.produitId} : ${quantiteNonCouverte} unités manquantes.`,
      });
    }

    for (const lotChoisi of lotsChoisis) {
      lignesBl.push({
        produitId: ligne.produitId,
        lotId: lotChoisi.lotId,
        quantiteEnvoyee: lotChoisi.quantite,
      });
    }
  }

  const bl = await prisma.bordereauLivraison.create({
    data: {
      requisitionId: requisition.id,
      etablissementExpediteurId: etablissementId,
      etablissementDestinataireId: requisition.etablissementDemandeurId,
      statut: "ENVOYE",
      lignes: { create: lignesBl },
    },
    include: { lignes: true },
  });

  // Décrémenter les lots et journaliser les mouvements de sortie.
  for (const lb of lignesBl) {
    await prisma.lot.update({
      where: { id: lb.lotId },
      data: { quantite: { decrement: lb.quantiteEnvoyee } },
    });
    await prisma.mouvementStock.create({
      data: {
        lotId: lb.lotId,
        type: "SORTIE",
        quantite: lb.quantiteEnvoyee,
        referenceType: "BL",
        referenceId: bl.id,
        utilisateurId: req.utilisateur.utilisateurId,
      },
    });
  }

  await prisma.requisition.update({
    where: { id: requisition.id },
    data: { statut: "EXPEDIEE" },
  });

  return res.status(201).json(bl);
}

// GET /reception/en-attente
// BL envoyés à l'établissement connecté, pas encore confirmés.
async function listerEnAttenteReception(req, res) {
  const { etablissementId } = req.utilisateur;

  const bls = await prisma.bordereauLivraison.findMany({
    where: { etablissementDestinataireId: etablissementId, statut: "ENVOYE" },
    include: { lignes: { include: { produit: true, lot: true } } },
  });

  return res.json(bls);
}

// POST /reception/:blId/confirmer
// Body : { lignes: [{ blLigneId, quantiteRecue }] }
// Compare quantité envoyée / reçue par ligne. Sans écart : stock mis à jour
// automatiquement. Avec écart : la ligne est bloquée en attente d'arbitrage.
async function confirmerReception(req, res) {
  const { etablissementId, utilisateurId } = req.utilisateur;
  const { blId } = req.params;
  const { lignes } = req.body;

  const bl = await prisma.bordereauLivraison.findUnique({
    where: { id: blId },
    include: { lignes: true },
  });

  if (!bl || bl.etablissementDestinataireId !== etablissementId) {
    return res.status(404).json({ erreur: "Bordereau introuvable pour cet établissement." });
  }

  let auMoinsUnEcart = false;

  for (const ligneRecue of lignes) {
    const ligneBl = bl.lignes.find((l) => l.id === ligneRecue.blLigneId);
    if (!ligneBl) continue;

    const ecart = ligneBl.quantiteEnvoyee - ligneRecue.quantiteRecue;

    if (ecart === 0) {
      // Pas d'écart : mise à jour automatique du stock du destinataire.
      await prisma.stock.upsert({
        where: { produitId_etablissementId: { produitId: ligneBl.produitId, etablissementId } },
        update: { quantiteTotale: { increment: ligneRecue.quantiteRecue } },
        create: {
          produitId: ligneBl.produitId,
          etablissementId,
          quantiteTotale: ligneRecue.quantiteRecue,
          seuilMin: 0,
          seuilMax: 0,
        },
      });

      await prisma.lot.create({
        data: {
          produitId: ligneBl.produitId,
          etablissementId,
          numeroLot: `RECU-${ligneBl.lotId}`,
          datePeremption: new Date(),
          quantite: ligneRecue.quantiteRecue,
        },
      });

      await prisma.blLigne.update({
        where: { id: ligneBl.id },
        data: { quantiteRecue: ligneRecue.quantiteRecue, ecart: 0 },
      });
    } else {
      auMoinsUnEcart = true;
      await prisma.blLigne.update({
        where: { id: ligneBl.id },
        data: {
          quantiteRecue: ligneRecue.quantiteRecue,
          ecart,
          ecartStatut: "EN_ATTENTE",
        },
      });
    }
  }

  const statutBl = auMoinsUnEcart ? "RECU_AVEC_ECART_BLOQUE" : "RECU_SANS_ECART";
  const misAJour = await prisma.bordereauLivraison.update({
    where: { id: blId },
    data: { statut: statutBl, dateReceptionConfirmee: new Date() },
  });

  return res.json(misAJour);
}

module.exports = {
  listerPretesAExpedier,
  genererBl,
  listerEnAttenteReception,
  confirmerReception,
};
