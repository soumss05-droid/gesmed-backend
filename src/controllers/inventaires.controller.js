const prisma = require("../config/prisma");
const { recalculerStatutStock, perimetreEtablissementIds } = require("./stocks.controller");

// POST /inventaires
// Enregistre une session d'inventaire physique pour l'établissement actif
// de l'utilisateur connecté. Chaque ligne compare la quantité physique
// comptée à la quantité système figée au moment du comptage. Ne bloque
// jamais le système : les écarts sont marqués EN_ATTENTE et doivent être
// tranchés (débloquer ou maintenir) par une autorité, exactement comme les
// écarts de BL — jamais d'ajustement automatique du stock, pour ne pas
// permettre d'effacer facilement une perte sans justification.
//
// Une ligne peut désigner soit un lot déjà connu du système (lotId), soit
// un lot physiquement trouvé sur le terrain mais encore inconnu du système
// (produitId + numeroLot + datePeremption) — cas d'un produit dont le stock
// théorique est resté à zéro alors qu'il existe réellement (jamais reçu par
// BL, saisi par erreur, etc.). Dans ce second cas, le lot est créé avec une
// quantité système de 0, exactement comme s'il avait toujours existé mais
// jamais compté — l'écart (= la quantité comptée) suit alors le même
// circuit de décision que n'importe quel autre écart d'inventaire.
async function creerInventaire(req, res) {
  const { etablissementId } = req.utilisateur;
  const { type, commentaire, lignes } = req.body;

  if (!etablissementId) {
    return res.status(403).json({
      erreur: "Cet utilisateur n'est rattaché à aucun établissement et ne peut pas saisir d'inventaire.",
    });
  }
  if (!type || !["PONCTUEL", "PERIODIQUE"].includes(type)) {
    return res.status(400).json({ erreur: "Le type d'inventaire doit être PONCTUEL ou PERIODIQUE." });
  }
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ erreur: "Au moins un lot compté est requis." });
  }
  for (const ligne of lignes) {
    if (ligne.quantitePhysique === undefined || ligne.quantitePhysique === null) {
      return res.status(400).json({ erreur: "Chaque ligne doit contenir une quantité physique." });
    }
    if (Number(ligne.quantitePhysique) < 0) {
      return res.status(400).json({ erreur: "La quantité physique ne peut pas être négative." });
    }
    if (!ligne.lotId && !(ligne.produitId && ligne.numeroLot && ligne.datePeremption)) {
      return res.status(400).json({
        erreur: "Chaque ligne doit contenir soit un lotId existant, soit produitId + numeroLot + datePeremption pour un nouveau lot.",
      });
    }
  }

  const lignesLotExistant = lignes.filter((l) => l.lotId);
  const lignesNouveauLot = lignes.filter((l) => !l.lotId);

  const lotIds = lignesLotExistant.map((l) => l.lotId);
  const lots = await prisma.lot.findMany({
    where: { id: { in: lotIds } },
    include: { produit: { select: { nom: true } } },
  });
  const lotsParId = new Map(lots.map((l) => [l.id, l]));

  for (const ligne of lignesLotExistant) {
    const lot = lotsParId.get(ligne.lotId);
    if (!lot) {
      return res.status(404).json({ erreur: `Lot introuvable (id: ${ligne.lotId}).` });
    }
    if (lot.etablissementId !== etablissementId) {
      return res.status(403).json({
        erreur: `Le lot "${lot.numeroLot}" (${lot.produit.nom}) n'appartient pas à ton établissement.`,
      });
    }
  }

  // Crée d'abord les nouveaux lots (quantité système 0), et s'assure que le
  // stock agrégé existe pour ce produit à cet établissement — sinon le
  // déblocage ultérieur de l'écart échouerait faute de ligne Stock à mettre
  // à jour.
  const nouveauxLotsParLigne = new Map();
  for (const ligne of lignesNouveauLot) {
    let nouveauLot;
    try {
      nouveauLot = await prisma.lot.create({
        data: {
          produitId: ligne.produitId,
          etablissementId,
          numeroLot: ligne.numeroLot,
          datePeremption: new Date(ligne.datePeremption),
          quantite: 0,
        },
      });
    } catch (erreur) {
      if (erreur.code === "P2002") {
        return res.status(409).json({
          erreur: `Le numéro de lot "${ligne.numeroLot}" est déjà utilisé à cet établissement (pour un autre produit, ou avec une autre péremption).`,
        });
      }
      throw erreur;
    }
    nouveauxLotsParLigne.set(ligne, nouveauLot);

    const stockExistant = await prisma.stock.findUnique({
      where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
    });
    if (!stockExistant) {
      const produit = await prisma.produit.findUnique({ where: { id: ligne.produitId } });
      await prisma.stock.create({
        data: {
          produitId: ligne.produitId,
          etablissementId,
          quantiteTotale: 0,
          seuilMin: produit?.seuilMinDefaut ?? 0,
          seuilMax: produit?.seuilMaxDefaut ?? 0,
          statut: "RUPTURE",
        },
      });
    }
  }

  const toutesLesLignes = [
    ...lignesLotExistant.map((ligne) => {
      const lot = lotsParId.get(ligne.lotId);
      const quantitePhysique = Number(ligne.quantitePhysique);
      const ecart = quantitePhysique - lot.quantite;
      return {
        lotId: ligne.lotId,
        quantiteSysteme: lot.quantite,
        quantitePhysique,
        ecart,
        ecartStatut: ecart !== 0 ? "EN_ATTENTE" : null,
      };
    }),
    ...lignesNouveauLot.map((ligne) => {
      const nouveauLot = nouveauxLotsParLigne.get(ligne);
      const quantitePhysique = Number(ligne.quantitePhysique);
      return {
        lotId: nouveauLot.id,
        quantiteSysteme: 0,
        quantitePhysique,
        ecart: quantitePhysique,
        ecartStatut: quantitePhysique !== 0 ? "EN_ATTENTE" : null,
      };
    }),
  ];

  const inventaire = await prisma.inventairePhysique.create({
    data: {
      etablissementId,
      effectueParId: req.utilisateur.utilisateurId,
      type,
      commentaire: commentaire || null,
      lignes: { create: toutesLesLignes },
    },
    include: {
      lignes: { include: { lot: { include: { produit: { select: { nom: true } } } } } },
    },
  });

  return res.status(201).json({ message: "Inventaire enregistré avec succès", inventaire });
}

// GET /inventaires
// Historique des inventaires de l'établissement actif, du plus récent au plus ancien.
async function listerInventaires(req, res) {
  const { etablissementId } = req.utilisateur;
  if (!etablissementId) {
    return res.status(403).json({ erreur: "Cet utilisateur n'est rattaché à aucun établissement." });
  }

  const inventaires = await prisma.inventairePhysique.findMany({
    where: { etablissementId },
    orderBy: { dateInventaire: "desc" },
    include: {
      effectuePar: { select: { nomComplet: true } },
      lignes: { include: { lot: { select: { numeroLot: true, produit: { select: { nom: true } } } } } },
    },
  });

  return res.json(inventaires);
}

// GET /inventaires/ecarts-en-attente
// Réservé à GAS_PROGRAMME_NATIONAL et AUDITEUR (vérifié par le middleware
// autoriser) — vue nationale de tous les écarts d'inventaire en attente de décision.
async function listerEcartsInventaireEnAttente(req, res) {
  const ecarts = await prisma.ligneInventaire.findMany({
    where: { ecartStatut: "EN_ATTENTE" },
    include: {
      lot: { include: { produit: true, etablissement: { select: { nom: true } } } },
      inventaire: { include: { effectuePar: { select: { nomComplet: true } } } },
    },
    orderBy: { inventaire: { dateInventaire: "asc" } },
  });

  return res.json(ecarts);
}

// POST /inventaires/lignes/:ligneId/decision
// Body : { decision: "debloquer" | "maintenir", motif }
// Le motif est obligatoire dans les deux cas — aucune décision d'écart,
// perte ou surplus, ne doit rester sans justification écrite.
// "maintenir" : le stock système reste tel quel, l'écart est classé sans
// correction (perte ou surplus constaté mais non répercuté).
// "debloquer" : le stock est ajusté pour correspondre au comptage physique.
async function traiterEcartInventaire(req, res) {
  const { utilisateurId } = req.utilisateur;
  const { ligneId } = req.params;
  const { decision, motif } = req.body;

  if (!motif || !motif.trim()) {
    return res.status(400).json({ erreur: "Un motif est obligatoire pour trancher un écart." });
  }

  const ligne = await prisma.ligneInventaire.findUnique({
    where: { id: ligneId },
    include: { lot: true },
  });

  if (!ligne || ligne.ecartStatut !== "EN_ATTENTE") {
    return res.status(404).json({ erreur: "Écart introuvable ou déjà traité." });
  }

  if (decision === "maintenir") {
    const misAJour = await prisma.ligneInventaire.update({
      where: { id: ligneId },
      data: { ecartStatut: "MAINTENU", ecartDecideurId: utilisateurId, ecartMotif: motif.trim() },
    });
    return res.json(misAJour);
  }

  if (decision === "debloquer") {
    await prisma.lot.update({
      where: { id: ligne.lotId },
      data: { quantite: { increment: ligne.ecart } },
    });
    await prisma.stock.update({
      where: { produitId_etablissementId: { produitId: ligne.lot.produitId, etablissementId: ligne.lot.etablissementId } },
      data: { quantiteTotale: { increment: ligne.ecart } },
    });
    // Le statut n'est jamais recalculé automatiquement par Prisma : sans cet
    // appel, un stock resterait affiché "Rupture" même après un ajustement
    // qui le remonte largement au-dessus du seuil.
    await recalculerStatutStock(ligne.lot.produitId, ligne.lot.etablissementId);

    await prisma.mouvementStock.create({
      data: {
        lotId: ligne.lotId,
        type: "AJUSTEMENT",
        quantite: Math.abs(ligne.ecart),
        referenceType: "MANUEL",
        referenceId: ligne.id,
        utilisateurId,
      },
    });

    const misAJour = await prisma.ligneInventaire.update({
      where: { id: ligneId },
      data: { ecartStatut: "DEBLOQUE", ecartDecideurId: utilisateurId, ecartMotif: motif.trim() },
    });
    return res.json(misAJour);
  }

  return res.status(400).json({ erreur: "Décision non reconnue." });
}

// GET /inventaires/zone
// Vue consolidée, en lecture seule, de tous les inventaires réalisés dans
// le périmètre réel de l'utilisateur connecté (région entière pour un GAS
// DRS/Directeur DRS, Moughataa entière pour un GAS Moughataa/Médecin Chef,
// national pour Admin/Auditeur — même logique que Stock du réseau). Chaque
// établissement continue de saisir SON PROPRE inventaire physiquement sur
// place ; cette vue permet seulement au responsable de zone d'être informé
// de ce qui a déjà été fait ailleurs dans son périmètre, sans jamais saisir
// à la place de qui que ce soit.
async function listerInventairesZone(req, res) {
  const { etablissementId, role } = req.utilisateur;
  if (!etablissementId) {
    return res.status(403).json({ erreur: "Cet utilisateur n'est rattaché à aucun établissement." });
  }

  const etablissementIds = await perimetreEtablissementIds(etablissementId, role);

  const inventaires = await prisma.inventairePhysique.findMany({
    where: etablissementIds ? { etablissementId: { in: etablissementIds } } : {},
    orderBy: { dateInventaire: "desc" },
    include: {
      etablissement: { select: { nom: true } },
      effectuePar: { select: { nomComplet: true } },
      lignes: { include: { lot: { select: { numeroLot: true, produit: { select: { nom: true } } } } } },
    },
    take: 200,
  });

  return res.json(inventaires);
}

module.exports = {
  creerInventaire,
  listerInventaires,
  listerEcartsInventaireEnAttente,
  traiterEcartInventaire,
  listerInventairesZone,
};