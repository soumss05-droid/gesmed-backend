const prisma = require("../config/prisma");
const { selectionnerLotFEFO } = require("./stocks.controller");

const ORDRE_CIRCUIT = [
  "FORMATION_SANITAIRE",
  "GAS_MOUGHATAA",
  "GAS_DRS",
  "GAS_PROGRAMME_NATIONAL",
  "CAMEC",
];

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

async function listerAValider(req, res) {
  const { etablissementId } = req.utilisateur;
  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etablissementId, statut: { in: ["EN_ATTENTE", "MODIFIEE_EN_ATTENTE_CONFIRMATION"] } },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
    orderBy: { dateCreation: "asc" },
  });
  return res.json(requisitions);
}

// Détermine l'établissement qui a envoyé la réquisition au niveau actuel,
// pour que toute modification de quantités lui soit renvoyée en confirmation
// avant de continuer le circuit. Le chemin est déterministe : il dépend
// uniquement de la localisation de la formation sanitaire demandeuse
// d'origine (moughataaId, drsId), sauf pour le dernier maillon
// (GAS Programme national) où il dépend du programme des produits — stable
// à ce stade puisqu'une réquisition ne porte plus qu'un seul programme une
// fois passée la scission au niveau du GAS DRS.
async function trouverEtablissementPrecedent(etabActuel, requisitionAJour) {
  const indexActuel = ORDRE_CIRCUIT.indexOf(etabActuel.type);
  const typePrecedent = ORDRE_CIRCUIT[indexActuel - 1];
  if (!typePrecedent) return null;

  if (typePrecedent === "FORMATION_SANITAIRE") {
    return prisma.etablissement.findUnique({ where: { id: requisitionAJour.etablissementDemandeurId } });
  }

  const demandeur = await prisma.etablissement.findUnique({
    where: { id: requisitionAJour.etablissementDemandeurId },
  });

  if (typePrecedent === "GAS_MOUGHATAA") {
    return prisma.etablissement.findFirst({
      where: { type: "GAS_MOUGHATAA", moughataaId: demandeur.moughataaId },
    });
  }

  if (typePrecedent === "GAS_DRS") {
    return prisma.etablissement.findFirst({
      where: { type: "GAS_DRS", drsId: demandeur.drsId },
    });
  }

  if (typePrecedent === "GAS_PROGRAMME_NATIONAL") {
    const programmeId = requisitionAJour.lignes[0]?.produit?.programmeId;
    return prisma.etablissement.findFirst({
      where: { type: "GAS_PROGRAMME_NATIONAL", programmeId },
    });
  }

  return null;
}

async function traiterDecision(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { id } = req.params;
  const { decision, lignes } = req.body;

  const requisition = await prisma.requisition.findUnique({ where: { id } });
  if (!requisition || requisition.niveauActuelId !== etablissementId) {
    return res.status(404).json({ erreur: "Réquisition introuvable à ce niveau." });
  }

  if (decision === "rejeter") {
    const misAJour = await prisma.requisition.update({ where: { id }, data: { statut: "REJETEE" } });
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

    const requisitionAJour = await prisma.requisition.findUnique({
      where: { id },
      include: { lignes: { include: { produit: true } } },
    });
    const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });
    const etablissementPrecedent = await trouverEtablissementPrecedent(etabActuel, requisitionAJour);

    if (!etablissementPrecedent) {
      return res.status(500).json({
        erreur: "Impossible de déterminer le niveau précédent pour confirmer cette modification.",
      });
    }

    const misAJour = await prisma.requisition.update({
      where: { id },
      data: { statut: "MODIFIEE_EN_ATTENTE_CONFIRMATION", niveauActuelId: etablissementPrecedent.id },
    });
    return res.json(misAJour);
  }

  if (decision === "valider") {
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
      include: { lignes: { include: { produit: true } } },
    });

    const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

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
      for (const { ligne, aLivrer } of lignesALivrer) {
        await prisma.stock.update({
          where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
          data: { quantiteTotale: { decrement: aLivrer } },
        });
      }
    }

    if (lignesARemonter.length === 0) {
      const misAJour = await prisma.requisition.update({ where: { id }, data: { statut: "CLOTUREE" } });
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

    // Regroupe les lignes à remonter par établissement destinataire. Au niveau
    // GAS Programme national, le regroupement se fait par programme (chaque
    // produit appartient à un programme, et chaque GAS Programme national ne
    // gère qu'un seul programme) — pas juste "le premier trouvé".
    const groupes = new Map();
    if (typeSuivant === "GAS_PROGRAMME_NATIONAL") {
      for (const { ligne, aRemonter } of lignesARemonter) {
        const programmeId = ligne.produit.programmeId;
        const etabDest = await prisma.etablissement.findFirst({
          where: { type: "GAS_PROGRAMME_NATIONAL", programmeId },
        });
        if (!etabDest) {
          return res.status(500).json({ erreur: `Aucun GAS Programme national trouvé pour le programme de ${ligne.produit.nom}.` });
        }
        if (!groupes.has(etabDest.id)) groupes.set(etabDest.id, { etablissement: etabDest, items: [] });
        groupes.get(etabDest.id).items.push({ ligne, aRemonter });
      }
    } else {
      const niveauSuivant = await prisma.etablissement.findFirst({
        where: {
          type: typeSuivant,
          ...(typeSuivant === "GAS_DRS" ? { drsId: etabActuel.drsId } : {}),
        },
      });
      groupes.set(niveauSuivant.id, { etablissement: niveauSuivant, items: lignesARemonter });
    }

    if (lignesALivrer.length === 0 && groupes.size === 1) {
      const [seulGroupe] = Array.from(groupes.values());
      const misAJour = await prisma.requisition.update({
        where: { id },
        data: { statut: "EN_ATTENTE", niveauActuelId: seulGroupe.etablissement.id },
      });
      return res.json({ requisition: misAJour, bordereauLivraison: null, livreeDirectement: false });
    }

    const requisitionsFilles = [];
    for (const { etablissement, items } of groupes.values()) {
      const fille = await prisma.requisition.create({
        data: {
          etablissementDemandeurId: requisitionAJour.etablissementDemandeurId,
          niveauActuelId: etablissement.id,
          statut: "EN_ATTENTE",
          justification: requisitionAJour.justification,
          requisitionParentId: requisitionAJour.id,
          lignes: {
            create: items.map(({ ligne, aRemonter }) => ({
              produitId: ligne.produitId,
              quantiteDemandee: aRemonter,
              quantiteValidee: aRemonter,
            })),
          },
        },
      });
      requisitionsFilles.push(fille);
    }

    const misAJour = await prisma.requisition.update({ where: { id }, data: { statut: "SCINDEE" } });

    return res.json({
      requisition: misAJour,
      requisitionsFilles,
      bordereauLivraison: blGenere,
      livreeDirectement: lignesALivrer.length > 0,
      partiel: lignesALivrer.length > 0,
    });
  }

  return res.status(400).json({ erreur: "Décision non reconnue." });
}

module.exports = { creerRequisition, listerAValider, traiterDecision };