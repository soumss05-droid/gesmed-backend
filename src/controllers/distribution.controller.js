const prisma = require("../config/prisma");
const { executerValidationOuModification, ErreurMetier } = require("./requisitions.controller");
const { recalculerStatutStock, creerOuIncrementerLot } = require("./stocks.controller");

// GET /distribution/pretes
// Réquisitions dont il reste un reliquat à envoyer depuis l'établissement
// connecté (CAMEC ou GAS DRS) : arrivées au bout du circuit sans pouvoir
// être totalement livrées faute de stock à ce moment-là.
async function listerPretesAExpedier(req, res) {
  const { etablissementId } = req.utilisateur;

  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etablissementId, statut: "VALIDEE" },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
  });

  return res.json(requisitions);
}

// POST /distribution/:requisitionId/generer-bl
// Relance la livraison d'une réquisition restée "VALIDEE" (reliquat non
// couvert lors du premier passage), maintenant que le stock a pu être
// reconstitué. Ne duplique aucune logique : délègue entièrement à
// executerValidationOuModification, le même chemin que la validation
// initiale — mêmes statuts, mêmes notifications, même alerte de rupture.
async function genererBl(req, res) {
  const { etablissementId, utilisateurId } = req.utilisateur;
  const { requisitionId } = req.params;

  try {
    const resultat = await executerValidationOuModification({
      etablissementId,
      utilisateurId,
      requisitionId,
      decision: "valider",
      lignes: null,
    });

    if (!resultat.bordereauLivraison) {
      return res.status(400).json({
        erreur: "Rien à expédier pour l'instant : le stock ne couvre toujours pas ce reliquat.",
      });
    }

    return res.status(201).json(resultat);
  } catch (erreur) {
    if (erreur instanceof ErreurMetier) {
      return res.status(erreur.statut).json({ erreur: erreur.message });
    }
    console.error("Erreur lors de la relance de l'expédition :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de la relance de l'expédition." });
  }
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
// automatiquement, avec un nouveau lot reprenant le vrai numéro et la vraie
// date de péremption du lot d'origine. Avec écart : la ligne est bloquée en
// attente d'arbitrage (voir ecarts.controller.js).
async function confirmerReception(req, res) {
  const { etablissementId, utilisateurId } = req.utilisateur;
  const { blId } = req.params;
  const { lignes } = req.body;

  const bl = await prisma.bordereauLivraison.findUnique({
    where: { id: blId },
    include: { lignes: { include: { lot: true } } },
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
      const stockExistant = await prisma.stock.findUnique({
        where: { produitId_etablissementId: { produitId: ligneBl.produitId, etablissementId } },
      });

      if (stockExistant) {
        await prisma.stock.update({
          where: { produitId_etablissementId: { produitId: ligneBl.produitId, etablissementId } },
          data: { quantiteTotale: { increment: ligneRecue.quantiteRecue } },
        });
      } else {
        const produit = await prisma.produit.findUnique({ where: { id: ligneBl.produitId } });
        await prisma.stock.create({
          data: {
            produitId: ligneBl.produitId,
            etablissementId,
            quantiteTotale: ligneRecue.quantiteRecue,
            seuilMin: produit?.seuilMinDefaut ?? 0,
            seuilMax: produit?.seuilMaxDefaut ?? 0,
            statut: "RUPTURE", // recalculé juste en dessous, valeur de départ neutre
          },
        });
      }
      // Le statut n'est jamais recalculé automatiquement par Prisma : sans
      // cet appel, un stock resterait affiché "Rupture" même après une
      // réception qui le remonte largement au-dessus du seuil.
      await recalculerStatutStock(ligneBl.produitId, etablissementId);

      const nouveauLot = await creerOuIncrementerLot({
        produitId: ligneBl.produitId,
        etablissementId,
        numeroLot: ligneBl.lot.numeroLot,
        datePeremption: ligneBl.lot.datePeremption,
        quantite: ligneRecue.quantiteRecue,
      });

      await prisma.mouvementStock.create({
        data: {
          lotId: nouveauLot.id,
          type: "ENTREE",
          quantite: ligneRecue.quantiteRecue,
          referenceType: "BL",
          referenceId: bl.id,
          utilisateurId,
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