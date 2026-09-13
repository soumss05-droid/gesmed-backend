const prisma = require("../config/prisma");
const { selectionnerLotFEFO } = require("./stocks.controller");

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
    // Applique d'abord les quantités validées transmises par le formulaire.
    if (Array.isArray(lignes)) {
      await Promise.all(
        lignes.map((l) =>
          prisma.requisitionLigne.update({
            where: { id: l.requisitionLigneId },
            data: { quantiteValidee: l.quantiteValidee },
          })
        )
      );
    }

    const requisitionAJour = await prisma.requisition.findUnique({
      where: { id },
      include: { lignes: true },
    });

    const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

    // Pour chaque ligne, détermine ce qui peut être livré directement depuis le stock de ce niveau.
    const repartition = [];
    for (const ligne of requisitionAJour.lignes) {
      const stock = await prisma.stock.findUnique({
        where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
      });
      const disponible = stock ? stock.quantiteTotale : 0;
      const aLivrer = Math.min(ligne.quantiteValidee, disponible);
      const aRemonter = ligne.quantiteValidee - aLivrer;
      repartition.push({ ligne, aLivrer, aRemonter });
    }

    const lignesALivrer = repartition.filter((r) => r.aLivrer > 0);
    const lignesARemonter = repartition.filter((r) => r.aRemonter > 0);

    let blGenere = null;
    if (lignesALivrer.length > 0) {
      const lignesBl = [];
      for (const { ligne, aLivrer } of lignesALivrer) {
        const { lotsChoisis } = await selectionnerLotFEFO(ligne.produitId, etablissementId, aLivrer);
        for (const lotChoisi of lotsChoisis) {
          lignesBl.push({ produitId: ligne.produitId, lotId: lotChoisi.lotId, quantiteEnvoyee: lotChoisi.quantite });
        }
      }
      blGenere = await prisma.bordereauLivraison.create({
        data: {
          requisitionId: requisitionAJour.id,
          etablissementExpediteurId: etablissementId,
          etablissementDestinataireId: requisitionAJour.etablissementDemandeurId,
          statut: "ENVOYE",
          lignes: { create: lignesBl },
        },
        include: { lignes: true },
      });
      for (const lb of lignesBl) {
        await prisma.lot.update({ where: { id: lb.lotId }, data: { quantite: { decrement: lb.quantiteEnvoyee } } });
        await prisma.mouvementStock.create({
          data: {
            lotId: lb.lotId,
            type: "SORTIE",
            quantite: lb.quantiteEnvoyee,
            referenceType: "BL",
            referenceId: blGenere.id,
            utilisateurId: req.utilisateur.utilisateurId,
          },
        });
      }
      // Décrémente aussi le total agrégé du stock de l'expéditeur.
      for (const { ligne, aLivrer } of lignesALivrer) {
        await prisma.stock.update({
          where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
          data: { quantiteTotale: { decrement: aLivrer } },
        });
      }
    }

    if (lignesARemonter.length === 0) {
      const misAJour = await prisma.requisition.update({
        where: { id },
        data: { statut: "CLOTUREE" },
      });
      return res.json({ requisition: misAJour, bordereauLivraison: blGenere, livreeDirectement: true });
    }

    const indexActuel = ORDRE_CIRCUIT.indexOf(etabActuel.type);
    const typeSuivant = ORDRE_CIRCUIT[indexActuel + 1];

    if (!typeSuivant) {
      await Promise.all(
        lignesARemonter.map(({ ligne, aRemonter }) =>
          prisma.requisitionLigne.update({ where: { id: ligne.id }, data: { quantiteValidee: aRemonter } })
        )
      );
      const misAJour = await prisma.requisition.update({ where: { id }, data: { statut: "VALIDEE" } });
      return res.json({ requisition: misAJour, bordereauLivraison: blGenere, livreeDirectement: lignesALivrer.length > 0 });
    }

    const niveauSuivant = await prisma.etablissement.findFirst({
      where: {
        type: typeSuivant,
        ...(typeSuivant === "GAS_DRS" ? { drsId: etabActuel.drsId } : {}),
      },
    });

    if (lignesALivrer.length === 0) {
      const misAJour = await prisma.requisition.update({
        where: { id },
        data: { statut: "EN_ATTENTE", niveauActuelId: niveauSuivant.id },
      });
      return res.json({ requisition: misAJour, bordereauLivraison: null, livreeDirectement: false });
    }

    const requisitionFille = await prisma.requisition.create({
      data: {
        etablissementDemandeurId: requisitionAJour.etablissementDemandeurId,
        niveauActuelId: niveauSuivant.id,
        statut: "EN_ATTENTE",
        justification: requisitionAJour.justification,
        requisitionParentId: requisitionAJour.id,
        lignes: {
          create: lignesARemonter.map(({ ligne, aRemonter }) => ({
            produitId: ligne.produitId,
            quantiteDemandee: aRemonter,
            quantiteValidee: aRemonter,
          })),
        },
      },
    });

    const misAJour = await prisma.requisition.update({
      where: { id },
      data: { statut: "SCINDEE" },
    });

    return res.json({ requisition: misAJour, requisitionFille, bordereauLivraison: blGenere, livreeDirectement: true, partiel: true });
  }

  return res.status(400).json({ erreur: "Décision non reconnue." });
}

module.exports = { creerRequisition, listerAValider, traiterDecision };