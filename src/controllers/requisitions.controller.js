const prisma = require("../config/prisma");
const { selectionnerLotFEFO, calculerCommandeSuggereePourEtablissement } = require("./stocks.controller");

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
    where: {
      niveauActuelId: etablissementId,
      statut: { in: ["EN_ATTENTE", "REJETEE_POUR_CORRECTION"] },
    },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
    orderBy: { dateCreation: "asc" },
  });
  return res.json(requisitions);
}

// GET /requisitions/mes-requisitions
async function listerMesRequisitions(req, res) {
  const { etablissementId } = req.utilisateur;
  const requisitions = await prisma.requisition.findMany({
    where: { etablissementDemandeurId: etablissementId, requisitionParentId: null },
    include: {
      lignes: { include: { produit: true } },
      niveauActuel: { select: { nom: true } },
      requisitionsEnfants: {
        include: {
          lignes: { include: { produit: true } },
          niveauActuel: { select: { nom: true } },
        },
      },
    },
    orderBy: { dateCreation: "desc" },
  });
  return res.json(requisitions);
}

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

async function creerNotification({ etablissementId, etablissementAuteurId = null, type, message, requisitionId = null, produitId = null }) {
  try {
    await prisma.notification.create({
      data: { etablissementId, etablissementAuteurId, type, message, requisitionId, produitId },
    });
  } catch (erreur) {
    console.error("Erreur lors de la création d'une notification :", erreur);
  }
}

// Erreur "métier" : porte un statut HTTP, pour que les points d'entrée
// (route directe ou appel interne depuis distribution.controller.js)
// puissent répondre de façon cohérente sans dupliquer la logique.
class ErreurMetier extends Error {
  constructor(statut, message) {
    super(message);
    this.statut = statut;
  }
}

// ---------------------------------------------------------------------------
// Cœur du traitement "valider" / "modifier" : ajuste éventuellement les
// quantités, livre ce qui est possible avec le stock local (FEFO), alerte en
// cas de rupture à la CAMEC, puis fait avancer la réquisition dans le
// circuit (clôture, remontée simple, ou scission par programme). Exportée
// pour être réutilisée par distribution.controller.js quand on relance
// l'envoi d'un reliquat une fois le stock reconstitué — pas de logique
// dupliquée, un seul chemin de vérité.
//
// IMPORTANT — règle métier (revue) : une réquisition NORMALE d'une
// formation sanitaire n'est traitée qu'une seule fois, au niveau GAS
// Moughataa, puis se clôture immédiatement (livraison complète ou
// partielle) — elle ne remonte JAMAIS au-delà. La même règle s'applique à
// la commande de réapprovisionnement d'un GAS Moughataa traitée par le GAS
// DRS : clôture immédiate, jamais de remontée vers CAMEC pour le compte du
// Moughataa. Seule la propre commande du GAS DRS vers CAMEC (pour son
// besoin régional) continue d'escalader via le GAS Programme national —
// c'est la seule voie légitime vers CAMEC hors exception géographique.
async function executerValidationOuModification({ etablissementId, utilisateurId, requisitionId, decision, lignes }) {
  const requisition = await prisma.requisition.findUnique({ where: { id: requisitionId } });
  if (!requisition || requisition.niveauActuelId !== etablissementId) {
    throw new ErreurMetier(404, "Réquisition introuvable à ce niveau.");
  }

  const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

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
    where: { id: requisitionId },
    include: { lignes: { include: { produit: true } } },
  });

  const typeNotif = decision === "modifier" ? "MODIFIEE" : "VALIDEE";
  const etablissementPrecedent = await trouverEtablissementPrecedent(etabActuel, requisitionAJour);

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
          utilisateurId,
        },
      });
    }
    for (const { ligne, aLivrer } of lignesALivrer) {
      await prisma.stock.update({
        where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
        data: { quantiteTotale: { decrement: aLivrer } },
      });
    }

    // Alerte de rupture : uniquement quand c'est la CAMEC qui vient de
    // livrer et que son propre stock tombe à zéro pour ce produit.
    if (etabActuel.type === "CAMEC") {
      for (const { ligne } of lignesALivrer) {
        const stockActuel = await prisma.stock.findUnique({
          where: { produitId_etablissementId: { produitId: ligne.produitId, etablissementId } },
        });
        if (stockActuel && stockActuel.quantiteTotale <= 0) {
          const requisitionsEnCours = await prisma.requisition.findMany({
            where: {
              statut: { in: ["EN_ATTENTE", "REJETEE_POUR_CORRECTION"] },
              lignes: { some: { produitId: ligne.produitId } },
            },
            select: { etablissementDemandeurId: true },
            distinct: ["etablissementDemandeurId"],
          });
          for (const r of requisitionsEnCours) {
            await creerNotification({
              etablissementId: r.etablissementDemandeurId,
              etablissementAuteurId: etabActuel.id,
              type: "RUPTURE_STOCK",
              message: `Le produit "${ligne.produit.nom}" est en rupture à la CAMEC. Évite de le commander pour l'instant.`,
              produitId: ligne.produitId,
            });
          }
        }
      }
    }
  }

  if (lignesARemonter.length === 0) {
    const misAJour = await prisma.requisition.update({ where: { id: requisitionId }, data: { statut: "CLOTUREE" } });
    if (etablissementPrecedent) {
      await creerNotification({
        etablissementId: etablissementPrecedent.id,
        etablissementAuteurId: etabActuel.id,
        type: typeNotif,
        message:
          decision === "modifier"
            ? "Ta réquisition a été modifiée puis entièrement livrée."
            : "Ta réquisition a été validée et entièrement livrée.",
        requisitionId,
      });
    }
    return { requisition: misAJour, bordereauLivraison: blGenere, livreeDirectement: true };
  }

  // -------------------------------------------------------------------------
  // Pas d'escalade dans deux cas précis : (1) GAS Moughataa traitant une
  // réquisition normale d'une formation sanitaire, (2) GAS DRS traitant la
  // commande de réapprovisionnement d'un GAS Moughataa. Dans les deux cas,
  // on clôture avec ce qui a pu être livré — complet ou partiel — sans
  // jamais remonter plus haut. La propre commande du GAS DRS vers CAMEC
  // (demandeur = le GAS DRS lui-même) continue elle d'escalader normalement
  // via le GAS Programme national, plus bas dans cette fonction.
  // -------------------------------------------------------------------------
  let pasEscalade = etabActuel.type === "GAS_MOUGHATAA";
  if (etabActuel.type === "GAS_DRS") {
    const demandeurEtab = await prisma.etablissement.findUnique({
      where: { id: requisitionAJour.etablissementDemandeurId },
    });
    pasEscalade = demandeurEtab?.type === "GAS_MOUGHATAA";
  }

  if (pasEscalade) {
    await Promise.all(
      lignesARemonter.map(({ ligne, aRemonter }) =>
        prisma.requisitionLigne.update({
          where: { id: ligne.id },
          data: { quantiteValidee: ligne.quantiteValidee - aRemonter },
        })
      )
    );
    const misAJour = await prisma.requisition.update({ where: { id: requisitionId }, data: { statut: "CLOTUREE" } });
    if (etablissementPrecedent) {
      await creerNotification({
        etablissementId: etablissementPrecedent.id,
        etablissementAuteurId: etabActuel.id,
        type: typeNotif,
        message:
          lignesALivrer.length > 0
            ? "Ta réquisition a été livrée partiellement — le reste n'a pas pu être fourni pour l'instant."
            : `Ta réquisition n'a pas pu être livrée : stock insuffisant au ${etabActuel.type === "GAS_MOUGHATAA" ? "GAS Moughataa" : "GAS DRS"}.`,
        requisitionId,
      });
    }
    return {
      requisition: misAJour,
      bordereauLivraison: blGenere,
      livreeDirectement: lignesALivrer.length > 0,
      partiel: lignesALivrer.length > 0,
      escalade: false,
    };
  }

  const indexActuel = ORDRE_CIRCUIT.indexOf(etabActuel.type);
  const typeSuivant = ORDRE_CIRCUIT[indexActuel + 1];

  if (!typeSuivant) {
    await Promise.all(
      lignesARemonter.map(({ ligne, aRemonter }) =>
        prisma.requisitionLigne.update({ where: { id: ligne.id }, data: { quantiteValidee: aRemonter } })
      )
    );
    const misAJour = await prisma.requisition.update({ where: { id: requisitionId }, data: { statut: "VALIDEE" } });
    if (etablissementPrecedent) {
      await creerNotification({
        etablissementId: etablissementPrecedent.id,
        etablissementAuteurId: etabActuel.id,
        type: typeNotif,
        message:
          decision === "modifier"
            ? "Ta réquisition a été modifiée au dernier niveau du circuit."
            : "Ta réquisition a été validée au dernier niveau du circuit.",
        requisitionId,
      });
    }
    return { requisition: misAJour, bordereauLivraison: blGenere, livreeDirectement: lignesALivrer.length > 0 };
  }

  const groupes = new Map();
  if (typeSuivant === "GAS_PROGRAMME_NATIONAL") {
    for (const { ligne, aRemonter } of lignesARemonter) {
      const programmeId = ligne.produit.programmeId;
      const etabDest = await prisma.etablissement.findFirst({
        where: { type: "GAS_PROGRAMME_NATIONAL", programmeId },
      });
      if (!etabDest) {
        throw new ErreurMetier(500, `Aucun GAS Programme national trouvé pour le programme de ${ligne.produit.nom}.`);
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
      where: { id: requisitionId },
      data: { statut: "EN_ATTENTE", niveauActuelId: seulGroupe.etablissement.id },
    });
    if (etablissementPrecedent) {
      await creerNotification({
        etablissementId: etablissementPrecedent.id,
        etablissementAuteurId: etabActuel.id,
        type: typeNotif,
        message:
          decision === "modifier"
            ? `Ta réquisition a été modifiée et transmise à ${seulGroupe.etablissement.nom}.`
            : `Ta réquisition a été validée et transmise à ${seulGroupe.etablissement.nom}.`,
        requisitionId,
      });
    }
    return { requisition: misAJour, bordereauLivraison: null, livreeDirectement: false };
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

  const misAJour = await prisma.requisition.update({ where: { id: requisitionId }, data: { statut: "SCINDEE" } });

  if (etablissementPrecedent) {
    const nomsDestinations = Array.from(groupes.values())
      .map((g) => g.etablissement.nom)
      .join(", ");
    await creerNotification({
      etablissementId: etablissementPrecedent.id,
      etablissementAuteurId: etabActuel.id,
      type: "SCINDEE",
      message: `Ta réquisition a été scindée en ${requisitionsFilles.length} réquisition(s), envoyée(s) à : ${nomsDestinations}.`,
      requisitionId,
    });
  }

  return {
    requisition: misAJour,
    requisitionsFilles,
    bordereauLivraison: blGenere,
    livreeDirectement: lignesALivrer.length > 0,
    partiel: lignesALivrer.length > 0,
  };
}

async function traiterDecision(req, res) {
  const { etablissementId, role, utilisateurId } = req.utilisateur;
  const { id } = req.params;
  const { decision, lignes } = req.body;

  const requisition = await prisma.requisition.findUnique({ where: { id } });
  if (!requisition || requisition.niveauActuelId !== etablissementId) {
    return res.status(404).json({ erreur: "Réquisition introuvable à ce niveau." });
  }

  const etabActuel = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  if (decision === "rejeter") {
    if (role !== "GAS_PROGRAMME_NATIONAL") {
      return res.status(403).json({
        erreur: "Seul le GAS Programme national peut rejeter une réquisition (les autres niveaux valident ou modifient).",
      });
    }

    const requisitionAvecLignes = await prisma.requisition.findUnique({
      where: { id },
      include: { lignes: { include: { produit: true } } },
    });

    const etablissementPrecedent = await trouverEtablissementPrecedent(etabActuel, requisitionAvecLignes);
    if (!etablissementPrecedent) {
      return res.status(500).json({
        erreur: "Impossible de déterminer le GAS DRS à qui renvoyer cette réquisition.",
      });
    }

    const misAJour = await prisma.requisition.update({
      where: { id },
      data: { statut: "REJETEE_POUR_CORRECTION", niveauActuelId: etablissementPrecedent.id },
    });

    await creerNotification({
      etablissementId: etablissementPrecedent.id,
      etablissementAuteurId: etabActuel.id,
      type: "REJETEE_POUR_CORRECTION",
      message: `La réquisition envoyée au GAS Programme national a été rejetée et nécessite une correction.`,
      requisitionId: id,
    });

    return res.json(misAJour);
  }

  if (decision === "valider" || decision === "modifier") {
    try {
      const resultat = await executerValidationOuModification({
        etablissementId,
        utilisateurId,
        requisitionId: id,
        decision,
        lignes,
      });
      return res.json(resultat);
    } catch (erreur) {
      if (erreur instanceof ErreurMetier) {
        return res.status(erreur.statut).json({ erreur: erreur.message });
      }
      console.error("Erreur lors du traitement de la décision :", erreur);
      return res.status(500).json({ erreur: "Erreur serveur lors du traitement de la décision." });
    }
  }

  return res.status(400).json({ erreur: "Décision non reconnue." });
}

async function creerCommandeReapprovisionnement(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { lignes, justification } = req.body;

  if (!["GAS_MOUGHATAA", "GESTIONNAIRE_DRS"].includes(role)) {
    return res.status(403).json({
      erreur: "Seuls le GAS Moughataa et le GAS DRS peuvent passer une commande de réapprovisionnement.",
    });
  }

  const etablissement = await prisma.etablissement.findUnique({ where: { id: etablissementId } });

  let lignesACommander;
  if (Array.isArray(lignes) && lignes.length > 0) {
    lignesACommander = lignes.map((l) => ({ produitId: l.produitId, quantite: Number(l.quantite) }));
  } else {
    const suggestions = await calculerCommandeSuggereePourEtablissement(etablissementId);
    lignesACommander = suggestions
      .filter((s) => s.quantiteSuggeree > 0)
      .map((s) => ({ produitId: s.produitId, quantite: s.quantiteSuggeree }));
  }

  if (lignesACommander.length === 0) {
    return res.status(400).json({
      erreur: "Aucun produit à commander (aucun besoin détecté, ou aucune ligne fournie).",
    });
  }

  if (etablissement.type === "GAS_MOUGHATAA") {
    const gasDrs = await prisma.etablissement.findFirst({
      where: { type: "GAS_DRS", drsId: etablissement.drsId },
    });
    if (!gasDrs) {
      return res.status(500).json({ erreur: "Aucun GAS DRS trouvé pour ce Moughataa." });
    }

    const requisition = await prisma.requisition.create({
      data: {
        etablissementDemandeurId: etablissementId,
        niveauActuelId: gasDrs.id,
        statut: "EN_ATTENTE",
        justification: justification || "Commande de réapprovisionnement (GAS Moughataa)",
        lignes: {
          create: lignesACommander.map((l) => ({
            produitId: l.produitId,
            quantiteDemandee: l.quantite,
            quantiteValidee: l.quantite,
          })),
        },
      },
      include: { lignes: true },
    });

    return res.status(201).json({ requisitions: [requisition] });
  }

  if (etablissement.type !== "GAS_DRS") {
    return res.status(500).json({ erreur: "Établissement incohérent pour ce rôle." });
  }

  const produitsInfo = await prisma.produit.findMany({
    where: { id: { in: lignesACommander.map((l) => l.produitId) } },
  });
  const produitParId = new Map(produitsInfo.map((p) => [p.id, p]));

  const groupes = new Map();
  for (const ligne of lignesACommander) {
    const produit = produitParId.get(ligne.produitId);
    const etabDest = await prisma.etablissement.findFirst({
      where: { type: "GAS_PROGRAMME_NATIONAL", programmeId: produit.programmeId },
    });
    if (!etabDest) {
      return res.status(500).json({
        erreur: `Aucun GAS Programme national trouvé pour le programme de ${produit.nom}.`,
      });
    }
    if (!groupes.has(etabDest.id)) groupes.set(etabDest.id, { etablissement: etabDest, items: [] });
    groupes.get(etabDest.id).items.push(ligne);
  }

  const requisitionsCreees = [];
  for (const { etablissement: etabDest, items } of groupes.values()) {
    const requisition = await prisma.requisition.create({
      data: {
        etablissementDemandeurId: etablissementId,
        niveauActuelId: etabDest.id,
        statut: "EN_ATTENTE",
        justification: justification || "Commande de réapprovisionnement (GAS DRS)",
        lignes: {
          create: items.map((l) => ({
            produitId: l.produitId,
            quantiteDemandee: l.quantite,
            quantiteValidee: l.quantite,
          })),
        },
      },
      include: { lignes: true },
    });
    requisitionsCreees.push(requisition);
  }

  return res.status(201).json({ requisitions: requisitionsCreees });
}

module.exports = {
  creerRequisition,
  listerAValider,
  listerMesRequisitions,
  traiterDecision,
  creerCommandeReapprovisionnement,
  executerValidationOuModification,
  ErreurMetier,
};