const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { authentifier } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

/**
 * Vérifie que l'utilisateur connecté peut saisir une rentrée à la CAMEC :
 * soit il est Admin système (Utilisateur.estAdminSysteme, absent du token
 * donc vérifié en base), soit son rôle actif (porté par le token) est
 * GESTIONNAIRE_CAMEC ET son établissement actif est bien de type CAMEC.
 */
async function verifierAccesCamec(req, res, next) {
  try {
    const { utilisateurId, etablissementId, role } = req.utilisateur;

    const utilisateur = await prisma.utilisateur.findUnique({
      where: { id: utilisateurId },
      select: { estAdminSysteme: true },
    });

    if (utilisateur?.estAdminSysteme) return next();

    if (role === "GESTIONNAIRE_CAMEC") {
      const etablissement = await prisma.etablissement.findUnique({
        where: { id: etablissementId },
        select: { type: true },
      });
      if (etablissement?.type === "CAMEC") return next();
    }

    return res.status(403).json({
      error: "Accès réservé au Gestionnaire CAMEC ou à l'Admin système.",
    });
  } catch (erreur) {
    console.error("Erreur lors de la vérification d'accès CAMEC :", erreur);
    return res.status(500).json({ error: "Erreur serveur lors de la vérification des droits" });
  }
}

const ETABLISSEMENT_CAMEC_ID = process.env.CAMEC_ETABLISSEMENT_ID || "camec-central";

/**
 * POST /receptions  (monté avec app.use("/receptions", receptionsRoutes))
 * Enregistre une rentrée de produits à la CAMEC centrale.
 * - Saisie libre (pas de commande fournisseur liée).
 * - Si le numéro de lot existe déjà pour ce produit à la CAMEC, la quantité
 *   est cumulée sur le lot existant plutôt que de créer un doublon.
 * - Le stock agrégé (table `stocks`) est mis à jour dans la même transaction.
 */
router.post("/", authentifier, verifierAccesCamec, async (req, res) => {
  const {
    produitId,
    numeroLot,
    datePeremption,
    quantite,
    dateReception,
    fournisseur,
    prixUnitaire,
    note,
  } = req.body;

  // Validation des champs obligatoires
  const champsManquants = [];
  if (!produitId) champsManquants.push("produitId");
  if (!numeroLot || !numeroLot.trim()) champsManquants.push("numeroLot");
  if (!datePeremption) champsManquants.push("datePeremption");
  if (!quantite || Number(quantite) <= 0) champsManquants.push("quantite");
  if (!dateReception) champsManquants.push("dateReception");

  if (champsManquants.length > 0) {
    return res.status(400).json({
      error: "Champs obligatoires manquants ou invalides",
      champs: champsManquants,
    });
  }

  const quantiteRecue = Number(quantite);

  try {
    const produit = await prisma.produit.findUnique({ where: { id: produitId } });
    if (!produit) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

    // Un numéro de lot est unique à l'échelle de l'établissement : il ne peut
    // désigner qu'un seul produit, et sa péremption est invariante une fois fixée.
    const lotMemeNumero = await prisma.lot.findFirst({
      where: {
        etablissementId: ETABLISSEMENT_CAMEC_ID,
        numeroLot: numeroLot.trim(),
      },
      include: { produit: { select: { nom: true } } },
    });

    if (lotMemeNumero && lotMemeNumero.produitId !== produitId) {
      return res.status(409).json({
        error: `Le numéro de lot "${numeroLot.trim()}" est déjà utilisé pour un autre produit (${lotMemeNumero.produit.nom}). Vérifie le numéro de lot ou le produit sélectionné.`,
      });
    }

    if (
      lotMemeNumero &&
      lotMemeNumero.produitId === produitId &&
      lotMemeNumero.datePeremption.toISOString().slice(0, 10) !== datePeremption
    ) {
      return res.status(409).json({
        error: `Le numéro de lot "${numeroLot.trim()}" existe déjà pour ce produit avec une date de péremption différente (${lotMemeNumero.datePeremption
          .toISOString()
          .slice(0, 10)}). Vérifie la date saisie.`,
      });
    }

    // Fonction utilitaire : calcule le statut d'un stock à partir de la
    // quantité totale et des seuils (obligatoires sur Stock).
    function calculerStatut(quantiteTotale, seuilMin, seuilMax) {
      if (quantiteTotale === 0) return "RUPTURE";
      if (quantiteTotale < seuilMin) return "SOUS_SEUIL";
      if (quantiteTotale > seuilMax) return "SURSTOCK";
      return "NORMAL";
    }

    const resultat = await prisma.$transaction(async (tx) => {
      let lot;
      if (lotMemeNumero) {
        // Même lot, même produit, même péremption : on cumule la quantité
        lot = await tx.lot.update({
          where: { id: lotMemeNumero.id },
          data: { quantite: { increment: quantiteRecue } },
        });
      } else {
        lot = await tx.lot.create({
          data: {
            produitId,
            etablissementId: ETABLISSEMENT_CAMEC_ID,
            numeroLot: numeroLot.trim(),
            datePeremption: new Date(datePeremption),
            quantite: quantiteRecue,
            dateReception: new Date(dateReception),
            fournisseur: fournisseur || null,
            prixUnitaire: prixUnitaire ? Number(prixUnitaire) : null,
            note: note || null,
          },
        });
      }

      // Mise à jour de l'agrégat de stock. seuilMin/seuilMax sont obligatoires :
      // à la création, on reprend les seuils par défaut du produit ; le statut
      // (RUPTURE/SOUS_SEUIL/NORMAL/SURSTOCK) est recalculé à chaque mouvement.
      const stockExistant = await tx.stock.findUnique({
        where: {
          produitId_etablissementId: {
            produitId,
            etablissementId: ETABLISSEMENT_CAMEC_ID,
          },
        },
      });

      const nouvelleQuantite = (stockExistant?.quantiteTotale ?? 0) + quantiteRecue;
      const seuilMin = stockExistant?.seuilMin ?? produit.seuilMinDefaut;
      const seuilMax = stockExistant?.seuilMax ?? produit.seuilMaxDefaut;

      const stock = await tx.stock.upsert({
        where: {
          produitId_etablissementId: {
            produitId,
            etablissementId: ETABLISSEMENT_CAMEC_ID,
          },
        },
        update: {
          quantiteTotale: nouvelleQuantite,
          statut: calculerStatut(nouvelleQuantite, seuilMin, seuilMax),
        },
        create: {
          produitId,
          etablissementId: ETABLISSEMENT_CAMEC_ID,
          quantiteTotale: nouvelleQuantite,
          seuilMin,
          seuilMax,
          statut: calculerStatut(nouvelleQuantite, seuilMin, seuilMax),
        },
      });

      // Historique du mouvement de stock (relié uniquement au lot : le
      // produit et l'établissement se déduisent de Lot).
      await tx.mouvementStock.create({
        data: {
          lotId: lot.id,
          type: "ENTREE",
          quantite: quantiteRecue,
          referenceType: "MANUEL",
          referenceId: lot.id,
          utilisateurId: req.utilisateur.utilisateurId,
        },
      });

      return { lot, stock };
    });

    return res.status(201).json({
      message: "Rentrée enregistrée avec succès",
      lot: resultat.lot,
      stockTotal: resultat.stock.quantiteTotale,
    });
  } catch (erreur) {
    console.error("Erreur lors de la rentrée de produits :", erreur);
    return res.status(500).json({ error: "Erreur serveur lors de l'enregistrement de la rentrée" });
  }
});

module.exports = router;
