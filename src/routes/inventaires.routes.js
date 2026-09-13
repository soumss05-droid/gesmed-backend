const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { authentifier } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

/**
 * POST /inventaires  (monté avec app.use("/inventaires", inventairesRoutes))
 * Enregistre une session d'inventaire physique pour l'établissement actif
 * de l'utilisateur connecté (celui porté par son token). Chaque ligne compare
 * la quantité physique comptée à la quantité système figée au moment du
 * comptage. Ne bloque jamais le système : sert uniquement à documenter les
 * écarts (pertes ou surplus) pour les rapports.
 */
router.post("/", authentifier, async (req, res) => {
  const { etablissementId } = req.utilisateur;
  const { type, commentaire, lignes } = req.body;

  if (!etablissementId) {
    return res.status(403).json({
      error: "Cet utilisateur n'est rattaché à aucun établissement et ne peut pas saisir d'inventaire.",
    });
  }

  if (!type || !["PONCTUEL", "PERIODIQUE"].includes(type)) {
    return res.status(400).json({ error: "Le type d'inventaire doit être PONCTUEL ou PERIODIQUE." });
  }

  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: "Au moins un lot compté est requis." });
  }

  for (const ligne of lignes) {
    if (!ligne.lotId || ligne.quantitePhysique === undefined || ligne.quantitePhysique === null) {
      return res.status(400).json({
        error: "Chaque ligne doit contenir lotId et quantitePhysique.",
      });
    }
    if (Number(ligne.quantitePhysique) < 0) {
      return res.status(400).json({ error: "La quantité physique ne peut pas être négative." });
    }
  }

  try {
    const lotIds = lignes.map((l) => l.lotId);
    const lots = await prisma.lot.findMany({
      where: { id: { in: lotIds } },
      include: { produit: { select: { nom: true } } },
    });

    const lotsParId = new Map(lots.map((l) => [l.id, l]));

    for (const ligne of lignes) {
      const lot = lotsParId.get(ligne.lotId);
      if (!lot) {
        return res.status(404).json({ error: `Lot introuvable (id: ${ligne.lotId}).` });
      }
      if (lot.etablissementId !== etablissementId) {
        return res.status(403).json({
          error: `Le lot "${lot.numeroLot}" (${lot.produit.nom}) n'appartient pas à ton établissement.`,
        });
      }
    }

    const inventaire = await prisma.inventairePhysique.create({
      data: {
        etablissementId,
        effectueParId: req.utilisateur.utilisateurId,
        type,
        commentaire: commentaire || null,
        lignes: {
          create: lignes.map((ligne) => {
            const lot = lotsParId.get(ligne.lotId);
            const quantitePhysique = Number(ligne.quantitePhysique);
            return {
              lotId: ligne.lotId,
              quantiteSysteme: lot.quantite,
              quantitePhysique,
              ecart: quantitePhysique - lot.quantite,
            };
          }),
        },
      },
      include: {
        lignes: {
          include: { lot: { include: { produit: { select: { nom: true } } } } },
        },
      },
    });

    return res.status(201).json({
      message: "Inventaire enregistré avec succès",
      inventaire,
    });
  } catch (erreur) {
    console.error("Erreur lors de l'enregistrement de l'inventaire :", erreur);
    return res.status(500).json({ error: "Erreur serveur lors de l'enregistrement de l'inventaire" });
  }
});

/**
 * GET /inventaires
 * Liste l'historique des inventaires déjà réalisés pour l'établissement
 * actif de l'utilisateur connecté, du plus récent au plus ancien.
 */
router.get("/", authentifier, async (req, res) => {
  const { etablissementId } = req.utilisateur;

  if (!etablissementId) {
    return res.status(403).json({
      error: "Cet utilisateur n'est rattaché à aucun établissement.",
    });
  }

  try {
    const inventaires = await prisma.inventairePhysique.findMany({
      where: { etablissementId },
      orderBy: { dateInventaire: "desc" },
      include: {
        effectuePar: { select: { nomComplet: true } },
        lignes: {
          include: {
            lot: {
              select: { numeroLot: true, produit: { select: { nom: true } } },
            },
          },
        },
      },
    });

    return res.json(inventaires);
  } catch (erreur) {
    console.error("Erreur lors du chargement des inventaires :", erreur);
    return res.status(500).json({ error: "Erreur serveur lors du chargement des inventaires" });
  }
});

module.exports = router;