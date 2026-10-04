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
  const { quantiteDemandee, motifDemande } = req.body;

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
  if (new Date(lot.datePeremption) >= maintenant) {
    return res.status(400).json({ erreur: "Seul un lot périmé peut faire l'objet d'une demande de destruction." });
  }

  const quantite = Number(quantiteDemandee);
  if (!quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "La quantité demandée doit être positive." });
  }
  if (quantite > lot.quantite) {
    return res.status(400).json({ erreur: `Quantité demandée (${quantite}) supérieure à la quantité restante du lot (${lot.quantite}).` });
  }

  const demandeExistante = await prisma.demandeDestructionLot.findFirst({
    where: { lotId, statut: "EN_ATTENTE" },
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
      demandeur: d.demandeur.nomComplet,
      dateDemande: d.dateDemande,
    }))
  );
}

// POST /stocks/lots/destructions/:demandeId/valider
// Body : { approuve? (true par défaut), quantiteDetruite?, commentaireValidation? }
// Réservé à GAS_PROGRAMME_NATIONAL et ADMIN. À l'approbation : décrémente
// définitivement Lot.quantite et Stock.quantiteTotale, trace un
// MouvementStock de type DESTRUCTION, puis recalcule le statut du stock
// (via la même fonction que partout ailleurs, pour rester cohérent).
async function validerDestructionLot(req, res) {
  const { role, utilisateurId } = req.utilisateur;
  if (!ROLES_VALIDATION_DESTRUCTION.includes(role)) {
    return res.status(403).json({ erreur: "Seul le Programme National ou l'Admin peut valider une destruction." });
  }

  const { demandeId } = req.params;
  const { approuve = true, quantiteDetruite, commentaireValidation } = req.body;

  const demande = await prisma.demandeDestructionLot.findUnique({
    where: { id: demandeId },
    include: { lot: true },
  });
  if (!demande) {
    return res.status(404).json({ erreur: "Demande de destruction introuvable." });
  }
  if (demande.statut !== "EN_ATTENTE") {
    return res.status(409).json({ erreur: "Cette demande a déjà été traitée." });
  }

  if (!approuve) {
    const demandeRejetee = await prisma.demandeDestructionLot.update({
      where: { id: demandeId },
      data: {
        statut: "REJETEE",
        validateurId: utilisateurId,
        dateValidation: new Date(),
        commentaireValidation: commentaireValidation?.trim() || null,
      },
    });
    return res.json({ message: "Demande de destruction rejetée.", demande: demandeRejetee });
  }

  const quantite = quantiteDetruite !== undefined ? Number(quantiteDetruite) : demande.quantiteDemandee;
  if (!quantite || quantite <= 0) {
    return res.status(400).json({ erreur: "La quantité détruite doit être positive." });
  }

  // Le lot peut avoir bougé depuis la demande (autre mouvement entre-temps) :
  // on revérifie sa quantité actuelle juste avant d'écrire, pas celle figée
  // au moment de la demande.
  const lotActuel = await prisma.lot.findUnique({ where: { id: demande.lotId } });
  if (!lotActuel) {
    return res.status(404).json({ erreur: "Le lot associé à cette demande n'existe plus." });
  }
  if (quantite > lotActuel.quantite) {
    return res.status(400).json({ erreur: `Quantité à détruire (${quantite}) supérieure à la quantité restante du lot (${lotActuel.quantite}).` });
  }

  const demandeValidee = await prisma.$transaction(async (tx) => {
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

    return tx.demandeDestructionLot.update({
      where: { id: demandeId },
      data: {
        statut: "VALIDEE",
        quantiteDetruite: quantite,
        validateurId: utilisateurId,
        dateValidation: new Date(),
        commentaireValidation: commentaireValidation?.trim() || null,
      },
    });
  });

  await recalculerStatutStock(lotActuel.produitId, lotActuel.etablissementId);

  return res.json({ message: "Destruction validée.", demande: demandeValidee });
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

module.exports = {
  ROLES_VALIDATION_DESTRUCTION,
  demanderDestructionLot,
  demandesDestructionAValider,
  validerDestructionLot,
  historiqueDestructions,
  supprimerHistoriqueDestructions,
};