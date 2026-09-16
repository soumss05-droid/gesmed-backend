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
// Liste les réquisitions créées par l'établissement de l'utilisateur
// connecté (celles où il est le demandeur d'origine), avec leur statut
// actuel et leur niveau actuel. Inclut aussi les réquisitions filles issues
// d'une éventuelle scission, pour que le demandeur voie le détail complet
// même quand sa demande a été répartie sur plusieurs programmes.
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

// Détermine l'établissement qui a envoyé la réquisition au niveau actuel —
// utilisé pour notifier ce niveau du résultat (validée/modifiée/scindée),
// et pour renvoyer la réquisition en correction en cas de rejet. Le chemin
// est déterministe : il dépend de la localisation de la formation sanitaire
// demandeuse d'origine (moughataaId, drsId), sauf pour le dernier maillon
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

// Enregistre une notification pour un établissement. N'importe quel
// utilisateur rattaché à cet établissement pourra la consulter — ce n'est
// jamais bloquant pour le circuit lui-même.
async function creerNotification({ etablissementId, type, message, requisitionId = null, produitId = null }) {
  try {
    await prisma.notification.create({
      data: { etablissementId, type, message, requisitionId, produitId },
    });
  } catch (erreur) {
    // Une notification manquée ne doit jamais faire échouer le circuit
    // métier — on journalise seulement.
    console.error("Erreur lors de la création d'une notification :", erreur);
  }
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

  // ---------------------------------------------------------------------
  // REJETER — réservé au GAS Programme national. Retourne la réquisition
  // au GAS DRS qui l'a envoyée, pour correction. Pas de délai automatique :
  // elle reste à ce statut jusqu'à ce que le GAS DRS agisse.
  // ---------------------------------------------------------------------
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
      type: "REJETEE_POUR_CORRECTION",
      message: `La réquisition envoyée au GAS Programme national a été rejetée et nécessite une correction.`,
      requisitionId: id,
    });

    return res.json(misAJour);
  }

  // ---------------------------------------------------------------------
  // VALIDER ou MODIFIER — partagent désormais la même logique : les
  // quantités sont éventuellement ajustées, puis la réquisition avance
  // normalement dans le circuit (livraison locale, remontée, scission).
  // Aucun blocage : seule la notification distingue une validation d'une
  // modification.
  // ---------------------------------------------------------------------
  if (decision === "valider" || decision === "modifier") {
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
      // livrer et que son propre stock tombe à zéro pour ce produit. On
      // notifie tous les établissements ayant une réquisition encore en
      // cours pour ce même produit précis, pour éviter qu'ils commandent
      // inutilement quelque chose de momentanément indisponible.
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
      const misAJour = await prisma.requisition.update({ where: { id }, data: { statut: "CLOTUREE" } });
      if (etablissementPrecedent) {
        await creerNotification({
          etablissementId: etablissementPrecedent.id,
          type: typeNotif,
          message:
            decision === "modifier"
              ? "Ta réquisition a été modifiée puis entièrement livrée."
              : "Ta réquisition a été validée et entièrement livrée.",
          requisitionId: id,
        });
      }
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
      if (etablissementPrecedent) {
        await creerNotification({
          etablissementId: etablissementPrecedent.id,
          type: typeNotif,
          message:
            decision === "modifier"
              ? "Ta réquisition a été modifiée au dernier niveau du circuit."
              : "Ta réquisition a été validée au dernier niveau du circuit.",
          requisitionId: id,
        });
      }
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
      if (etablissementPrecedent) {
        await creerNotification({
          etablissementId: etablissementPrecedent.id,
          type: typeNotif,
          message:
            decision === "modifier"
              ? `Ta réquisition a été modifiée et transmise à ${seulGroupe.etablissement.nom}.`
              : `Ta réquisition a été validée et transmise à ${seulGroupe.etablissement.nom}.`,
          requisitionId: id,
        });
      }
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

    if (etablissementPrecedent) {
      const nomsDestinations = Array.from(groupes.values())
        .map((g) => g.etablissement.nom)
        .join(", ");
      await creerNotification({
        etablissementId: etablissementPrecedent.id,
        type: "SCINDEE",
        message: `Ta réquisition a été scindée en ${requisitionsFilles.length} réquisition(s), envoyée(s) à : ${nomsDestinations}.`,
        requisitionId: id,
      });
    }

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

// POST /requisitions/reapprovisionnement
// Permet au GAS Moughataa et au GAS DRS de passer leur propre commande de
// réapprovisionnement, indépendamment de toute réquisition précise venant
// d'en dessous — basée sur leur CMM propre et leur stock disponible cumulé
// (voir calculerCommandeSuggereePourEtablissement). Réutilise le même
// circuit d'escalade que les réquisitions classiques : le GAS Moughataa
// commande à son GAS DRS, le GAS DRS commande au(x) GAS Programme national
// concerné(s) (scindé par programme si plusieurs sont touchés).
async function creerCommandeReapprovisionnement(req, res) {
  const { etablissementId, role } = req.utilisateur;
  const { lignes, justification } = req.body; // lignes optionnelles pour ajuster manuellement la suggestion

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

  // GAS DRS : regroupe les lignes par programme (comme la scission déjà en
  // place), puisqu'il n'existe pas un seul GAS Programme national mais un
  // par programme.
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

module.exports = { creerRequisition, listerAValider, listerMesRequisitions, traiterDecision, creerCommandeReapprovisionnement };