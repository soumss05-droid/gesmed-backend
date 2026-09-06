const prisma = require("../config/prisma");

// Ordre obligatoire du circuit, du plus bas au plus haut niveau.
// Utilisé pour déterminer le prochain niveau et empêcher tout court-circuit.
const ORDRE_CIRCUIT = [
  "FORMATION_SANITAIRE",
  "GAS_MOUGHATAA",
  "GAS_DRS",
  "GAS_PROGRAMME_NATIONAL",
  "CAMEC",
];

// POST /requisitions
// Body : { lignes: [{ produitId, quantiteDemandee }], justification }
// Créée par une formation sanitaire, envoyée automatiquement au niveau
// juste au-dessus dans le circuit (GAS Moughataa).
async function creerRequisition(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { lignes, justification } = req.body;

  if (role !== "FORMATION_SANITAIRE") {
    return res.status(403).json({ erreur: "Seule une formation sanitaire peut créer une réquisition." });
  }

  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ erreur: "Au moins un produit est requis." });
  }

  const etablissement = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    include: { moughataa: true },
  });

  const gasMoughataa = await prisma.etablissement.findFirst({
    where: { type: "GAS_MOUGHATAA", moughataaId: etablissement.moughataaId },
  });

  if (!gasMoughataa) {
    return res.status(500).json({ erreur: "Aucun GAS Moughataa trouvé pour cette formation sanitaire." });
  }

  const requisition = await prisma.requisition.create({
    data: {
      etablissementDemandeurId: etablissementId,
      niveauActuelId: gasMoughataa.id,
      statut: "EN_ATTENTE",
      justification: justification || null,
      lignes: {
        create: lignes.map((l) => ({
          produitId: l.produitId,
          quantiteDemandee: l.quantiteDemandee,
          quantiteValidee: l.quantiteDemandee,
        })),
      },
    },
    include: { lignes: true },
  });

  return res.status(201).json(requisition);
}

// GET /requisitions/a-valider
// Retourne les réquisitions actuellement à ce niveau, en attente de décision.
async function listerAValider(req, res) {
  const { etablissementId } = req.utilisateur;

  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etablissementId, statut: { in: ["EN_ATTENTE", "MODIFIEE_EN_ATTENTE_CONFIRMATION"] } },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
    orderBy: { dateCreation: "asc" },
  });

  return res.json(requisitions);
}

// POST /requisitions/:id/decision
// Body : { decision: "valider" | "modifier" | "rejeter", lignes?: [{ requisitionLigneId, quantiteValidee }] }
async function traiterDecision(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { id } = req.params;
  const { decision, lignes } = req.body;

  const requisition = await prisma.requisition.findUnique({ where: { id } });

  if (!requisition || requisition.niveauActuelId !== etablissementId) {
    return res.status(404).json({ erreur: "Réquisition introuvable à ce niveau." });
  }

  if (decision === "rejeter") {
    // Renvoi au niveau précédent dans le circuit (simplifié : au demandeur).
    // À affiner selon le niveau exact d'où elle vient.
    const misAJour = await prisma.requisition.update({
      where: { id },
      data: { statut: "REJETEE" },
    });
    return res.json(misAJour);
  }

  if (decision === "modifier" && Array.isArray(lignes)) {
    await Promise.all(
      lignes.map((l) =>
        prisma.requisitionLigne.update({
          where: { id: l.requisitionLigneId },
          data: { quantiteValidee: l.quantiteValidee },
        })
      )
    );

    // Une modification par le GAS Programme national doit revenir au GAS DRS
    // pour confirmation avant de poursuivre.
    if (role === "GAS_PROGRAMME_NATIONAL") {
      const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
      const gasDrs = await prisma.etablissement.findFirst({
        where: { type: "GAS_DRS", drsId: etabActuel.drsId },
      });
      const misAJour = await prisma.requisition.update({
        where: { id },
        data: { statut: "MODIFIEE_EN_ATTENTE_CONFIRMATION", niveauActuelId: gasDrs.id },
      });
      return res.json(misAJour);
    }
  }

  if (decision === "valider") {
    const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
    const indexActuel = ORDRE_CIRCUIT.indexOf(etabActuel.type);
    const typeSuivant = ORDRE_CIRCUIT[indexActuel + 1];

    if (!typeSuivant) {
      // Dernier niveau (CAMEC) : la réquisition est prête pour distribution.
      const misAJour = await prisma.requisition.update({
        where: { id },
        data: { statut: "VALIDEE" },
      });
      return res.json(misAJour);
    }

    const niveauSuivant = await prisma.etablissement.findFirst({
      where: {
        type: typeSuivant,
        ...(typeSuivant === "GAS_DRS" ? { drsId: etabActuel.drsId } : {}),
      },
    });

    const misAJour = await prisma.requisition.update({
      where: { id },
      data: { statut: "EN_ATTENTE", niveauActuelId: niveauSuivant.id },
    });
    return res.json(misAJour);
  }

  return res.status(400).json({ erreur: "Décision non reconnue." });
}

module.exports = { creerRequisition, listerAValider, traiterDecision };
