const prisma = require("../config/prisma");
const { recalculerStatutStock } = require("./stocks.controller");

// Validation d'une demande de destruction simplifiée, sans comité ni
// hiérarchie par établissement : n'importe quel compte Programme National
// ou Admin (rôle virtuel, jamais dans l'enum Role — voir estAdminSysteme
// dans auth.controller.js) peut valider n'importe quelle demande.
const ROLES_VALIDATION_DESTRUCTION = ["GAS_PROGRAMME_NATIONAL", "ADMIN"];

// POST /stocks/lots/:lotId/destruction
// Body : { quantiteDemandee, motifDemande? }
// Le gestionnaire de l'établissement qui détient le lot périmé demande sa
// destruction physique. Le lot a déjà été automatiquement exclu du stock
// disponible (voir quantitePerimee dans stocks.controller.js) : cette étape
// ne fait que démarrer le circuit administratif de validation.
async function demanderDestructionLot(req, res) {
  const { etablissementId, utilisateurId, role } = req.utilisateur;
  const { lotId } = req.params;
  const { quantiteDemandee, motifDemande, cause: causeBrute } = req.body;
  const cause = causeBrute === "AVARIE" ? "AVARIE" : "PERIME";

  if (role === "ADMIN") {
    return res.status(403).json({ erreur: "L'admin valide les demandes de destruction, il n'en crée pas." });
  }

  const lot = await prisma.lot.findUnique({ where: { id: lotId } });
  if (!lot) {
    return res.status(404).json({ erreur: "Lot introuvable." });
  }
  if (lot.etablissementId !== etablissementId) {
    return res.status(403).json({ erreur: "Ce lot n'appartient pas à ton établissement." });
  }

  const maintenant = new Date();
  if (cause !== "AVARIE" && new Date(lot.datePeremption) >= maintenant) {
    return res.status(400).json({ erreur: "Seul un lot périmé peut faire l'objet d'une demande de destruction." });
  }

  if (cause === "AVARIE" && !(motifDemande && String(motifDemande).trim())) {
    return res.status(400).json({ erreur: "Pour un produit avarié, le motif est obligatoire (nature de l'avarie)." });
  }

  const quantite = Number(quantiteDemandee);
  if (!quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "La quantité demandée doit être positive." });
  }
  if (quantite > lot.quantite) {
    return res.status(400).json({ erreur: `Quantité demandée (${quantite}) supérieure à la quantité restante du lot (${lot.quantite}).` });
  }

  const demandeExistante = await prisma.demandeDestructionLot.findFirst({
    where: { lotId, statut: { in: ["EN_ATTENTE", "AUTORISEE"] } },
  });
  if (demandeExistante) {
    return res.status(409).json({ erreur: "Une demande de destruction est déjà en attente pour ce lot." });
  }

  const demande = await prisma.demandeDestructionLot.create({
    data: {
      lotId,
      etablissementId,
      quantiteDemandee: quantite,
      motifDemande: motifDemande?.trim() || null,
      cause,
      demandeurId: utilisateurId,
    },
  });

  return res.status(201).json({ message: "Demande de destruction envoyée.", demande });
}

// GET /stocks/lots/destructions/a-valider
// Réservé à GAS_PROGRAMME_NATIONAL et ADMIN. Liste toutes les demandes en
// attente, tous établissements confondus (pas de filtre par hiérarchie :
// n'importe quel validateur autorisé peut traiter n'importe quelle demande).
async function demandesDestructionAValider(req, res) {
  const { role } = req.utilisateur;
  if (!ROLES_VALIDATION_DESTRUCTION.includes(role)) {
    return res.status(403).json({ erreur: "Seul le Programme National ou l'Admin peut valider une destruction." });
  }

  const demandes = await prisma.demandeDestructionLot.findMany({
    where: { statut: "EN_ATTENTE" },
    include: {
      lot: { include: { produit: true } },
      etablissement: { select: { nom: true } },
      demandeur: { select: { nomComplet: true } },
    },
    orderBy: { dateDemande: "asc" },
  });

  return res.json(
    demandes.map((d) => ({
      id: d.id,
      produit: d.lot.produit.nom,
      numeroLot: d.lot.numeroLot,
      datePeremption: d.lot.datePeremption,
      etablissement: d.etablissement.nom,
      quantiteDemandee: d.quantiteDemandee,
      motifDemande: d.motifDemande,
      cause: d.cause,
      demandeur: d.demandeur.nomComplet,
      dateDemande: d.dateDemande,
    }))
  );
}

// Notification envoyee a l'etablissement demandeur (ne bloque jamais l'operation).
async function notifierDestruction({ etablissementId, etablissementAuteurId, type, message, produitId }) {
  try {
    await prisma.notification.create({
      data: {
        etablissementId,
        etablissementAuteurId: etablissementAuteurId || null,
        type,
        message,
        produitId: produitId || null,
      },
    });
  } catch (erreur) {
    console.error("Erreur lors de la création d'une notification de destruction :", erreur);
  }
}

// POST /stocks/lots/destructions/:demandeId/valider
// Body : { approuve? (true par défaut), commentaireValidation? }
// Réservé à GAS_PROGRAMME_NATIONAL et ADMIN. AUTORISE (ou rejette) la demande.
// L'autorisation ne retire RIEN du stock : le demandeur est notifié, détruit
// physiquement les produits, puis confirme (voir confirmerDestructionLot).
async function validerDestructionLot(req, res) {
  const { role, utilisateurId, etablissementId } = req.utilisateur;
  if (!ROLES_VALIDATION_DESTRUCTION.includes(role)) {
    return res.status(403).json({ erreur: "Seul le Programme National ou l'Admin peut autoriser une destruction." });
  }

  const { demandeId } = req.params;
  const { approuve = true, commentaireValidation } = req.body;

  const demande = await prisma.demandeDestructionLot.findUnique({
    where: { id: demandeId },
    include: { lot: { include: { produit: true } } },
  });
  if (!demande) {
    return res.status(404).json({ erreur: "Demande de destruction introuvable." });
  }
  if (demande.statut !== "EN_ATTENTE") {
    return res.status(409).json({ erreur: "Cette demande a déjà été traitée." });
  }

  const commentaire = commentaireValidation ? String(commentaireValidation).trim() : "";
  const description = demande.lot.produit.nom + " (lot " + demande.lot.numeroLot + ")";

  if (!approuve) {
    if (!commentaire) {
      return res.status(400).json({ erreur: "Le motif du rejet est obligatoire." });
    }
    const demandeRejetee = await prisma.demandeDestructionLot.update({
      where: { id: demandeId },
      data: {
        statut: "REJETEE",
        validateurId: utilisateurId,
        dateValidation: new Date(),
        commentaireValidation: commentaire,
      },
    });
    await notifierDestruction({
      etablissementId: demande.etablissementId,
      etablissementAuteurId: etablissementId,
      type: "DESTRUCTION_REJETEE",
      message: "Demande de destruction rejetée pour " + description + ". Motif : " + commentaire,
      produitId: demande.lot.produitId,
    });
    return res.json({ message: "Demande de destruction rejetée.", demande: demandeRejetee });
  }

  const demandeAutorisee = await prisma.demandeDestructionLot.update({
    where: { id: demandeId },
    data: {
      statut: "AUTORISEE",
      validateurId: utilisateurId,
      dateValidation: new Date(),
      commentaireValidation: commentaire || null,
    },
  });
  await notifierDestruction({
    etablissementId: demande.etablissementId,
    etablissementAuteurId: etablissementId,
    type: "DESTRUCTION_AUTORISEE",
    message:
      "Destruction autorisée pour " + description + " : " + demande.quantiteDemandee +
      " unité(s). Procédez à la destruction puis confirmez-la dans « Destructions »." +
      (commentaire ? " Commentaire : " + commentaire : ""),
    produitId: demande.lot.produitId,
  });
  return res.json({ message: "Destruction autorisée. Le demandeur a été notifié.", demande: demandeAutorisee });
}

// POST /stocks/lots/destructions/:demandeId/confirmer
// Body : { quantiteDetruite?, commentaire? }
// Réservé aux utilisateurs de l'établissement qui a fait la demande, une fois
// celle-ci AUTORISEE. C'est ici que la quantité est retirée définitivement du
// lot et du stock, avec la trace d'un MouvementStock de type DESTRUCTION.
async function confirmerDestructionLot(req, res) {
  const { role, utilisateurId, etablissementId } = req.utilisateur;
  if (role === "ADMIN") {
    return res.status(403).json({ erreur: "L'admin autorise les destructions, il ne les confirme pas." });
  }

  const { demandeId } = req.params;
  const { quantiteDetruite, commentaire } = req.body;

  const demande = await prisma.demandeDestructionLot.findUnique({
    where: { id: demandeId },
    include: { lot: true },
  });
  if (!demande) {
    return res.status(404).json({ erreur: "Demande de destruction introuvable." });
  }
  if (demande.etablissementId !== etablissementId) {
    return res.status(403).json({ erreur: "Cette demande n'appartient pas à ton établissement." });
  }
  if (demande.statut === "VALIDEE") {
    return res.status(409).json({ erreur: "Cette destruction a déjà été confirmée." });
  }
  if (demande.statut !== "AUTORISEE") {
    return res.status(409).json({ erreur: "Cette demande n'est pas autorisée : la destruction ne peut pas être confirmée." });
  }

  const quantite =
    quantiteDetruite !== undefined && quantiteDetruite !== "" && quantiteDetruite !== null
      ? Number(quantiteDetruite)
      : demande.quantiteDemandee;
  if (!Number.isInteger(quantite) || quantite <= 0) {
    return res.status(400).json({ erreur: "La quantité détruite doit être un nombre entier positif." });
  }

  const lotActuel = await prisma.lot.findUnique({ where: { id: demande.lotId } });
  if (!lotActuel) {
    return res.status(404).json({ erreur: "Le lot associé à cette demande n'existe plus." });
  }
  if (quantite > lotActuel.quantite) {
    return res.status(400).json({
      erreur: "Quantité à détruire (" + quantite + ") supérieure à la quantité restante du lot (" + lotActuel.quantite + ").",
    });
  }

  const texteConfirmation = commentaire ? String(commentaire).trim() : "";
  const nouveauCommentaire = texteConfirmation
    ? (demande.commentaireValidation ? demande.commentaireValidation + " | " : "") + "Confirmation : " + texteConfirmation
    : demande.commentaireValidation;

  let demandeConfirmee;
  try {
    demandeConfirmee = await prisma.$transaction(async (tx) => {
      const marque = await tx.demandeDestructionLot.updateMany({
        where: { id: demandeId, statut: "AUTORISEE" },
        data: { statut: "VALIDEE", quantiteDetruite: quantite, commentaireValidation: nouveauCommentaire },
      });
      if (marque.count === 0) {
        throw new Error("DEJA_TRAITEE");
      }

      await tx.lot.update({
        where: { id: lotActuel.id },
        data: { quantite: { decrement: quantite } },
      });

      await tx.mouvementStock.create({
        data: {
          lotId: lotActuel.id,
          type: "SORTIE",
          quantite,
          referenceType: "DESTRUCTION",
          referenceId: demande.id,
          utilisateurId,
        },
      });

      const stockExistant = await tx.stock.findUnique({
        where: { produitId_etablissementId: { produitId: lotActuel.produitId, etablissementId: lotActuel.etablissementId } },
      });
      if (stockExistant) {
        await tx.stock.update({
          where: { produitId_etablissementId: { produitId: lotActuel.produitId, etablissementId: lotActuel.etablissementId } },
          data: { quantiteTotale: { decrement: quantite } },
        });
      }

      return tx.demandeDestructionLot.findUnique({ where: { id: demandeId } });
    });
  } catch (erreur) {
    if (erreur && erreur.message === "DEJA_TRAITEE") {
      return res.status(409).json({ erreur: "Cette destruction a déjà été confirmée." });
    }
    throw erreur;
  }

  await recalculerStatutStock(lotActuel.produitId, lotActuel.etablissementId);

  return res.json({ message: "Destruction confirmée : le stock a été mis à jour.", demande: demandeConfirmee });
}

// GET /stocks/lots/destructions/historique
// GAS_PROGRAMME_NATIONAL et ADMIN voient tout l'historique validé ; les
// autres rôles ne voient que celui de leur propre établissement.
async function historiqueDestructions(req, res) {
  const { role, etablissementId } = req.utilisateur;

  const filtre = ROLES_VALIDATION_DESTRUCTION.includes(role)
    ? { statut: "VALIDEE" }
    : { statut: "VALIDEE", etablissementId };

  const historique = await prisma.demandeDestructionLot.findMany({
    where: filtre,
    include: {
      lot: { include: { produit: true } },
      etablissement: { select: { nom: true } },
      demandeur: { select: { nomComplet: true } },
      validateur: { select: { nomComplet: true } },
    },
    orderBy: { dateValidation: "desc" },
  });

  return res.json(
    historique.map((d) => ({
      id: d.id,
      produit: d.lot.produit.nom,
      numeroLot: d.lot.numeroLot,
      datePeremption: d.lot.datePeremption,
      etablissement: d.etablissement.nom,
      quantiteDetruite: d.quantiteDetruite,
      motifDemande: d.motifDemande,
      cause: d.cause,
      demandeur: d.demandeur.nomComplet,
      dateDemande: d.dateDemande,
      validateur: d.validateur?.nomComplet || null,
      dateValidation: d.dateValidation,
      commentaireValidation: d.commentaireValidation,
    }))
  );
}

// DELETE /stocks/lots/destructions/historique
// Réservé exclusivement à l'ADMIN (pas même GAS_PROGRAMME_NATIONAL) :
// supprime définitivement tout l'historique des destructions validées.
// N'affecte ni les lots ni les stocks, déjà décrémentés à la validation —
// c'est uniquement l'enregistrement administratif qui disparaît.
async function supprimerHistoriqueDestructions(req, res) {
  const { role } = req.utilisateur;
  if (role !== "ADMIN") {
    return res.status(403).json({ erreur: "Seul l'Admin peut supprimer l'historique des destructions." });
  }

  const resultat = await prisma.demandeDestructionLot.deleteMany({ where: { statut: "VALIDEE" } });

  return res.json({ message: `${resultat.count} entrée(s) d'historique supprimée(s).`, nombreSupprime: resultat.count });
}

// GET /stocks/lots/destructions/mes-demandes
// Toutes les demandes (en attente, validées, rejetées) : celles de son établissement,
// ou toutes pour GAS_PROGRAMME_NATIONAL et ADMIN.
async function mesDemandesDestruction(req, res) {
  const { role, etablissementId } = req.utilisateur;
  const where = ROLES_VALIDATION_DESTRUCTION.includes(role) ? {} : { etablissementId };

  const demandes = await prisma.demandeDestructionLot.findMany({
    where,
    orderBy: { dateDemande: "desc" },
    take: 200,
    include: {
      lot: { include: { produit: true } },
      etablissement: { select: { nom: true } },
      demandeur: { select: { nomComplet: true } },
      validateur: { select: { nomComplet: true } },
    },
  });

  return res.json(
    demandes.map((d) => ({
      id: d.id,
      statut: d.statut,
      produit: d.lot.produit.nom,
      numeroLot: d.lot.numeroLot,
      datePeremption: d.lot.datePeremption,
      etablissement: d.etablissement.nom,
      quantiteDemandee: d.quantiteDemandee,
      quantiteDetruite: d.quantiteDetruite,
      motifDemande: d.motifDemande,
      cause: d.cause,
      demandeur: d.demandeur.nomComplet,
      dateDemande: d.dateDemande,
      validateur: d.validateur ? d.validateur.nomComplet : null,
      dateValidation: d.dateValidation,
      commentaireValidation: d.commentaireValidation,
    }))
  );
}

// GET /stocks/lots/destructions/mes-lots
// Lots de l'etablissement de l'utilisateur pouvant faire l'objet d'une demande
// de destruction : quantite positive, sans demande deja en cours. Lecture seule.
async function mesLotsDestruction(req, res) {
  const { etablissementId, role } = req.utilisateur;
  if (role === "ADMIN" || !etablissementId) {
    return res.json([]);
  }

  const lots = await prisma.lot.findMany({
    where: { etablissementId, quantite: { gt: 0 } },
    include: { produit: true },
    orderBy: [{ datePeremption: "asc" }],
  });
  const enCours = await prisma.demandeDestructionLot.findMany({
    where: { etablissementId, statut: { in: ["EN_ATTENTE", "AUTORISEE"] } },
    select: { lotId: true },
  });
  const bloques = new Set(enCours.map((d) => d.lotId));
  const maintenant = new Date();

  return res.json(
    lots
      .filter((l) => !bloques.has(l.id))
      .map((l) => ({
        id: l.id,
        produit: l.produit ? l.produit.nom : "—",
        numeroLot: l.numeroLot,
        datePeremption: l.datePeremption,
        quantite: l.quantite,
        perime: new Date(l.datePeremption) < maintenant,
      }))
  );
}

module.exports = {
  ROLES_VALIDATION_DESTRUCTION,
  demanderDestructionLot,
  demandesDestructionAValider,
  validerDestructionLot,
  historiqueDestructions,
  supprimerHistoriqueDestructions,
  mesDemandesDestruction,
  confirmerDestructionLot,
  mesLotsDestruction,
};