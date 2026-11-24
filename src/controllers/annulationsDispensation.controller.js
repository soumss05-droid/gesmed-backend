const crypto = require("crypto");
const prisma = require("../config/prisma");
const { recalculerStatutStock } = require("./stocks.controller");

const TABLE = "demandes_annulation_dispensations";
const ROLES_VALIDATEURS = ["GAS_MOUGHATAA", "MEDECIN_CHEF_MOUGHATAA", "ADMIN"];

function erreurMetier(message, statut) {
  const e = new Error(message);
  e.metier = true;
  e.statutHttp = statut || 400;
  return e;
}

function repondreErreur(res, e, contexte) {
  if (e && e.metier) return res.status(e.statutHttp || 400).json({ erreur: e.message });
  console.error("Erreur " + contexte + " :", e);
  return res.status(500).json({ erreur: "Erreur serveur." });
}

// Notification envoyee a la formation sanitaire (ne bloque jamais l'operation).
// Les nouveaux types de notification sont inseres en SQL direct.
async function notifier({ etablissementId, etablissementAuteurId, type, message, produitId }) {
  try {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "notifications" ("id", "etablissement_id", "etablissement_auteur_id", "type", "message", "produit_id") VALUES ($1, $2, $3, $4::"TypeNotification", $5, $6)',
      crypto.randomUUID(),
      etablissementId,
      etablissementAuteurId || null,
      type,
      message,
      produitId || null
    );
  } catch (e) {
    console.error("Erreur lors de la creation d'une notification d'annulation :", e);
  }
}

// POST /stocks/dispensation/:dispensationId/demande-annulation   { motif }
// Reserve a la formation sanitaire qui a enregistre la dispensation.
async function demanderAnnulation(req, res) {
  try {
    const { etablissementId, utilisateurId, role } = req.utilisateur;
    if (role !== "FORMATION_SANITAIRE") {
      return res.status(403).json({ erreur: "Seule une formation sanitaire peut demander l'annulation d'une dispensation." });
    }

    const motif = String((req.body && req.body.motif) || "").trim();
    if (motif.length < 5) {
      return res.status(400).json({ erreur: "Le motif de l'annulation est obligatoire (5 caractères minimum)." });
    }

    const dispensation = await prisma.dispensation.findUnique({ where: { id: req.params.dispensationId } });
    if (!dispensation || dispensation.etablissementId !== etablissementId) {
      return res.status(404).json({ erreur: "Dispensation introuvable." });
    }
    if (dispensation.statut !== "ACTIVE") {
      return res.status(400).json({ erreur: "Cette dispensation est déjà annulée." });
    }

    const enAttente = await prisma.$queryRawUnsafe(
      'SELECT "id" FROM "' + TABLE + '" WHERE "dispensation_id" = $1 AND "statut" = \'EN_ATTENTE\'',
      dispensation.id
    );
    if (enAttente.length > 0) {
      return res.status(409).json({ erreur: "Une demande d'annulation est déjà en attente pour cette dispensation." });
    }

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      'INSERT INTO "' + TABLE + '" ("id", "dispensation_id", "etablissement_id", "motif", "demandeur_id") VALUES ($1, $2, $3, $4, $5)',
      id,
      dispensation.id,
      etablissementId,
      motif,
      utilisateurId
    );

    return res.status(201).json({ message: "Demande d'annulation envoyée. Elle doit être validée par le MCM ou le SASSM.", id });
  } catch (e) {
    return repondreErreur(res, e, "demande d'annulation");
  }
}

// GET /stocks/dispensation/demandes-annulation
// Les demandes de la formation sanitaire connectee (pour afficher leur etat).
async function mesDemandesAnnulation(req, res) {
  try {
    const { etablissementId, role } = req.utilisateur;
    if (role !== "FORMATION_SANITAIRE") {
      return res.status(403).json({ erreur: "Réservé aux formations sanitaires." });
    }
    const lignes = await prisma.$queryRawUnsafe(
      'SELECT "id", "dispensation_id" AS "dispensationId", "motif", "statut", "date_demande" AS "dateDemande", "date_decision" AS "dateDecision", "commentaire_decision" AS "commentaireDecision" FROM "' +
        TABLE +
        '" WHERE "etablissement_id" = $1 ORDER BY "date_demande" DESC',
      etablissementId
    );
    return res.json(lignes);
  } catch (e) {
    return repondreErreur(res, e, "liste des demandes d'annulation");
  }
}

// GET /stocks/annulations/a-valider
// MCM / SASSM : demandes en attente des formations de leur Moughataa. ADMIN : toutes.
async function listerAnnulationsAValider(req, res) {
  try {
    const { etablissementId, role } = req.utilisateur;
    if (!ROLES_VALIDATEURS.includes(role)) {
      return res.status(403).json({ erreur: "Accès non autorisé." });
    }

    let where = "WHERE \"statut\" = 'EN_ATTENTE'";
    let params = [];

    if (role !== "ADMIN") {
      const moi = await prisma.etablissement.findUnique({ where: { id: etablissementId }, select: { moughataaId: true } });
      if (!moi || !moi.moughataaId) return res.json([]);
      const fosas = await prisma.etablissement.findMany({
        where: { type: "FORMATION_SANITAIRE", moughataaId: moi.moughataaId },
        select: { id: true },
      });
      if (fosas.length === 0) return res.json([]);
      params = fosas.map((f) => f.id);
      where += ' AND "etablissement_id" IN (' + params.map((_, i) => "$" + (i + 1)).join(", ") + ")";
    }

    const demandes = await prisma.$queryRawUnsafe(
      'SELECT "id", "dispensation_id" AS "dispensationId", "etablissement_id" AS "etablissementId", "motif", "demandeur_id" AS "demandeurId", "date_demande" AS "dateDemande" FROM "' +
        TABLE +
        '" ' +
        where +
        ' ORDER BY "date_demande" ASC',
      ...params
    );
    if (demandes.length === 0) return res.json([]);

    const dispensations = await prisma.dispensation.findMany({
      where: { id: { in: demandes.map((d) => d.dispensationId) } },
      include: { produit: { select: { nom: true } }, etablissement: { select: { nom: true } } },
    });
    const parId = new Map(dispensations.map((d) => [d.id, d]));
    const demandeurs = await prisma.utilisateur.findMany({
      where: { id: { in: demandes.map((d) => d.demandeurId) } },
      select: { id: true, nomComplet: true },
    });
    const nomDemandeur = new Map(demandeurs.map((u) => [u.id, u.nomComplet]));

    return res.json(
      demandes.map((d) => {
        const disp = parId.get(d.dispensationId);
        return {
          id: d.id,
          dispensationId: d.dispensationId,
          motif: d.motif,
          dateDemande: d.dateDemande,
          demandeur: nomDemandeur.get(d.demandeurId) || null,
          numero: disp ? disp.numero : null,
          produit: disp ? disp.produit.nom : null,
          quantite: disp ? disp.quantite : null,
          beneficiaire: disp ? disp.beneficiaire : null,
          typeBeneficiaire: disp ? disp.typeBeneficiaire : null,
          dateDispensation: disp ? disp.dateDispensation : null,
          montantTotal: disp && disp.montantTotal !== null ? Number(disp.montantTotal) : null,
          etablissement: disp ? disp.etablissement.nom : null,
        };
      })
    );
  } catch (e) {
    return repondreErreur(res, e, "liste des annulations à valider");
  }
}

// POST /stocks/annulations/:demandeId/decider   { approuve: true|false, commentaire? }
// MCM / SASSM de la Moughataa de la formation (ou ADMIN).
async function deciderAnnulation(req, res) {
  try {
    const { etablissementId, utilisateurId, role } = req.utilisateur;
    if (!ROLES_VALIDATEURS.includes(role)) {
      return res.status(403).json({ erreur: "Accès non autorisé." });
    }

    const approuve = req.body && req.body.approuve === true;
    const commentaire = String((req.body && req.body.commentaire) || "").trim();
    if (!approuve && commentaire.length < 3) {
      return res.status(400).json({ erreur: "Un commentaire est obligatoire pour refuser une annulation." });
    }

    const lignes = await prisma.$queryRawUnsafe(
      'SELECT "id", "dispensation_id" AS "dispensationId", "etablissement_id" AS "etablissementId", "motif", "statut" FROM "' + TABLE + '" WHERE "id" = $1',
      req.params.demandeId
    );
    const demande = lignes[0];
    if (!demande) return res.status(404).json({ erreur: "Demande introuvable." });
    if (demande.statut !== "EN_ATTENTE") {
      return res.status(409).json({ erreur: "Cette demande a déjà été traitée." });
    }

    if (role !== "ADMIN") {
      const moi = await prisma.etablissement.findUnique({ where: { id: etablissementId }, select: { moughataaId: true } });
      const fosa = await prisma.etablissement.findUnique({ where: { id: demande.etablissementId }, select: { moughataaId: true } });
      if (!moi || !moi.moughataaId || !fosa || fosa.moughataaId !== moi.moughataaId) {
        return res.status(403).json({ erreur: "Cette demande ne concerne pas une formation de votre Moughataa." });
      }
    }

    const dispensation = await prisma.dispensation.findUnique({
      where: { id: demande.dispensationId },
      include: { produit: { select: { nom: true } } },
    });
    if (!dispensation) return res.status(404).json({ erreur: "Dispensation introuvable." });

    if (!approuve) {
      const modifiees = await prisma.$executeRawUnsafe(
        'UPDATE "' + TABLE + '" SET "statut" = \'REFUSEE\', "validateur_id" = $1, "date_decision" = NOW(), "commentaire_decision" = $2 WHERE "id" = $3 AND "statut" = \'EN_ATTENTE\'',
        utilisateurId,
        commentaire,
        demande.id
      );
      if (modifiees !== 1) return res.status(409).json({ erreur: "Cette demande a déjà été traitée." });

      await notifier({
        etablissementId: demande.etablissementId,
        etablissementAuteurId: etablissementId,
        type: "ANNULATION_REFUSEE",
        message: "Annulation refusée pour la dispensation N° " + dispensation.numero + " (" + dispensation.produit.nom + ") : " + commentaire,
        produitId: dispensation.produitId,
      });
      return res.json({ message: "Demande refusée. La formation sanitaire est informée." });
    }

    // Validation : le stock revient dans les memes lots, tout ou rien.
    await prisma.$transaction(
      async (tx) => {
        const courante = await tx.dispensation.findUnique({ where: { id: dispensation.id } });
        if (!courante || courante.statut !== "ACTIVE") {
          throw erreurMetier("Cette dispensation est déjà annulée.", 409);
        }

        const dejaRestitue = await tx.mouvementStock.count({
          where: { type: "AJUSTEMENT", referenceType: "DISPENSATION", referenceId: courante.id },
        });
        if (dejaRestitue > 0) {
          throw erreurMetier("Le stock de cette dispensation a déjà été restitué.", 409);
        }

        const sorties = await tx.mouvementStock.findMany({
          where: { type: "SORTIE", referenceType: "DISPENSATION", referenceId: courante.id },
        });
        if (sorties.length === 0) {
          throw erreurMetier("Mouvements de stock de cette dispensation introuvables : annulation impossible.", 409);
        }

        let totalRestitue = 0;
        for (const m of sorties) {
          await tx.lot.update({ where: { id: m.lotId }, data: { quantite: { increment: m.quantite } } });
          await tx.mouvementStock.create({
            data: {
              lotId: m.lotId,
              type: "AJUSTEMENT",
              quantite: m.quantite,
              referenceType: "DISPENSATION",
              referenceId: courante.id,
              utilisateurId,
            },
          });
          totalRestitue += m.quantite;
        }

        await tx.stock.update({
          where: { produitId_etablissementId: { produitId: courante.produitId, etablissementId: courante.etablissementId } },
          data: { quantiteTotale: { increment: totalRestitue } },
        });

        await tx.dispensation.update({
          where: { id: courante.id },
          data: { statut: "ANNULEE", motifAnnulation: demande.motif },
        });

        const modifiees = await tx.$executeRawUnsafe(
          'UPDATE "' + TABLE + '" SET "statut" = \'VALIDEE\', "validateur_id" = $1, "date_decision" = NOW(), "commentaire_decision" = $2 WHERE "id" = $3 AND "statut" = \'EN_ATTENTE\'',
          utilisateurId,
          commentaire || null,
          demande.id
        );
        if (modifiees !== 1) throw erreurMetier("Cette demande a déjà été traitée.", 409);
      },
      { timeout: 30000, maxWait: 10000 }
    );

    try {
      await recalculerStatutStock(dispensation.produitId, dispensation.etablissementId);
    } catch (e) {
      console.error("Recalcul du statut de stock impossible :", e.message);
    }

    await notifier({
      etablissementId: demande.etablissementId,
      etablissementAuteurId: etablissementId,
      type: "ANNULATION_VALIDEE",
      message: "Annulation validée pour la dispensation N° " + dispensation.numero + " (" + dispensation.produit.nom + ") : le stock a été remis.",
      produitId: dispensation.produitId,
    });

    return res.json({ message: "Annulation validée. Le stock a été remis." });
  } catch (e) {
    return repondreErreur(res, e, "décision d'annulation");
  }
}

module.exports = {
  demanderAnnulation,
  mesDemandesAnnulation,
  listerAnnulationsAValider,
  deciderAnnulation,
};