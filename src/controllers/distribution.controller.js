const prisma = require("../config/prisma");
const { executerValidationOuModification, ErreurMetier } = require("./requisitions.controller");
const { recalculerStatutStock, creerOuIncrementerLot } = require("./stocks.controller");

// GET /distribution/pretes
// Réquisitions dont il reste un reliquat à envoyer depuis l'établissement
// connecté (CAMEC ou GAS DRS) : arrivées au bout du circuit sans pouvoir
// être totalement livrées faute de stock à ce moment-là.
async function listerPretesAExpedier(req, res) {
  const { etablissementId } = req.utilisateur;

  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etablissementId, statut: "VALIDEE" },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true, axe: true },
  });

  return res.json(requisitions);
}

// POST /distribution/:requisitionId/generer-bl
// Relance la livraison d'une réquisition restée "VALIDEE" (reliquat non
// couvert lors du premier passage), maintenant que le stock a pu être
// reconstitué. Ne duplique aucune logique : délègue entièrement à
// executerValidationOuModification, le même chemin que la validation
// initiale — mêmes statuts, mêmes notifications, même alerte de rupture.
async function genererBl(req, res) {
  const { etablissementId, utilisateurId } = req.utilisateur;
  const { requisitionId } = req.params;

  try {
    const resultat = await executerValidationOuModification({
      etablissementId,
      utilisateurId,
      requisitionId,
      decision: "valider",
      lignes: null,
    });

    if (!resultat.bordereauLivraison) {
      return res.status(400).json({
        erreur: "Rien à expédier pour l'instant : le stock ne couvre toujours pas ce reliquat.",
      });
    }

    return res.status(201).json(resultat);
  } catch (erreur) {
    if (erreur instanceof ErreurMetier) {
      return res.status(erreur.statut).json({ erreur: erreur.message });
    }
    console.error("Erreur lors de la relance de l'expédition :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de la relance de l'expédition." });
  }
}

// GET /envoyes/en-attente
// Nombre de BL envoyes par l'etablissement connecte (CAMEC) et pas encore confirmes par le destinataire.
async function compterEnvoyesEnAttente(req, res) {
  try {
    const { etablissementId } = req.utilisateur;
    const total = await prisma.bordereauLivraison.count({
      where: { etablissementExpediteurId: etablissementId, statut: "ENVOYE" },
    });
    return res.json({ total });
  } catch (erreur) {
    console.error("Erreur lors du comptage des BL envoyes :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du comptage des BL envoyes." });
  }
}

// GET /reception/en-attente
// BL envoyés à l'établissement connecté, pas encore confirmés.
async function listerEnAttenteReception(req, res) {
  const { etablissementId } = req.utilisateur;

  const bls = await prisma.bordereauLivraison.findMany({
    where: { etablissementDestinataireId: etablissementId, statut: "ENVOYE" },
    include: {
      lignes: { include: { produit: true, lot: true } },
      etablissementExpediteur: true,
    },
  });

  return res.json(bls);
}

// POST /reception/:blId/confirmer
// Body : { lignes: [{ blLigneId, quantiteRecue }] }
// Compare quantité envoyée / reçue par ligne. Sans écart : stock mis à jour
// automatiquement, avec un nouveau lot reprenant le vrai numéro et la vraie
// date de péremption du lot d'origine. Avec écart : la ligne est bloquée en
// attente d'arbitrage (voir ecarts.controller.js).
async function confirmerReception(req, res) {
  const { etablissementId, utilisateurId } = req.utilisateur;
  const { blId } = req.params;
  const { lignes } = req.body;

  const bl = await prisma.bordereauLivraison.findUnique({
    where: { id: blId },
    include: { lignes: { include: { lot: true } } },
  });

  if (!bl || bl.etablissementDestinataireId !== etablissementId) {
    return res.status(404).json({ erreur: "Bordereau introuvable pour cet établissement." });
  }

  let auMoinsUnEcart = false;

  for (const ligneRecue of lignes) {
    const ligneBl = bl.lignes.find((l) => l.id === ligneRecue.blLigneId);
    if (!ligneBl) continue;

    const ecart = ligneBl.quantiteEnvoyee - ligneRecue.quantiteRecue;

    if (ecart === 0) {
      const stockExistant = await prisma.stock.findUnique({
        where: { produitId_etablissementId: { produitId: ligneBl.produitId, etablissementId } },
      });

      if (stockExistant) {
        await prisma.stock.update({
          where: { produitId_etablissementId: { produitId: ligneBl.produitId, etablissementId } },
          data: { quantiteTotale: { increment: ligneRecue.quantiteRecue } },
        });
      } else {
        const produit = await prisma.produit.findUnique({ where: { id: ligneBl.produitId } });
        await prisma.stock.create({
          data: {
            produitId: ligneBl.produitId,
            etablissementId,
            quantiteTotale: ligneRecue.quantiteRecue,
            seuilMin: produit?.seuilMinDefaut ?? 0,
            seuilMax: produit?.seuilMaxDefaut ?? 0,
            statut: "RUPTURE", // recalculé juste en dessous, valeur de départ neutre
          },
        });
      }
      // Le statut n'est jamais recalculé automatiquement par Prisma : sans
      // cet appel, un stock resterait affiché "Rupture" même après une
      // réception qui le remonte largement au-dessus du seuil.
      await recalculerStatutStock(ligneBl.produitId, etablissementId);

      const nouveauLot = await creerOuIncrementerLot({
        produitId: ligneBl.produitId,
        etablissementId,
        numeroLot: ligneBl.lot.numeroLot,
        datePeremption: ligneBl.lot.datePeremption,
        prixUnitaire: ligneBl.lot.prixUnitaire,
        quantite: ligneRecue.quantiteRecue,
      });

      await prisma.mouvementStock.create({
        data: {
          lotId: nouveauLot.id,
          type: "ENTREE",
          quantite: ligneRecue.quantiteRecue,
          referenceType: "BL",
          referenceId: bl.id,
          utilisateurId,
        },
      });

      await prisma.blLigne.update({
        where: { id: ligneBl.id },
        data: { quantiteRecue: ligneRecue.quantiteRecue, ecart: 0 },
      });
    } else {
      auMoinsUnEcart = true;
      await prisma.blLigne.update({
        where: { id: ligneBl.id },
        data: {
          quantiteRecue: ligneRecue.quantiteRecue,
          ecart,
          ecartStatut: "EN_ATTENTE",
        },
      });
    }
  }

  const statutBl = auMoinsUnEcart ? "RECU_AVEC_ECART_BLOQUE" : "RECU_SANS_ECART";
  const misAJour = await prisma.bordereauLivraison.update({
    where: { id: blId },
    data: { statut: statutBl, dateReceptionConfirmee: new Date() },
  });

  return res.json(misAJour);
}

// ---------------------------------------------------------------------------
// Axes d'expedition (CAMEC) : regroupement de requisitions a expedier ensemble.
// Une requisition associee a un axe reste VALIDEE a la CAMEC ; le stock ne sort
// qu'au depart de l'axe, par le meme chemin que generer-bl.
// ---------------------------------------------------------------------------
async function exigerCamec(req, res) {
  const etab = await prisma.etablissement.findUnique({ where: { id: req.utilisateur.etablissementId } });
  if (!etab || etab.type !== "CAMEC") {
    res.status(403).json({ erreur: "Les axes d'exp\u00e9dition sont r\u00e9serv\u00e9s \u00e0 la CAMEC." });
    return null;
  }
  return etab;
}

// GET /distribution/axes
async function listerAxes(req, res) {
  const axes = await prisma.axe.findMany({ where: { actif: true }, orderBy: { nom: "asc" } });
  const axesAvecWilayas = await prisma.axe.findMany({
    where: { actif: true },
    orderBy: { nom: "asc" },
    include: { drs: { select: { id: true, code: true, nom: true, ordreAxe: true }, orderBy: { ordreAxe: "asc" } } },
  });
  return res.json(axesAvecWilayas);
}

// GET /distribution/axes/resume
// Par axe : commandes associees, total a charger par produit (avec le stock
// disponible a la CAMEC) et detail par etablissement destinataire.
async function resumeParAxe(req, res) {
  const etab = await exigerCamec(req, res);
  if (!etab) return undefined;

  const axes = await prisma.axe.findMany({ where: { actif: true }, orderBy: { nom: "asc" } });
  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etab.id, statut: "VALIDEE", axeId: { not: null } },
    include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
    orderBy: { numero: "asc" },
  });

  const stocks = await prisma.stock.findMany({ where: { etablissementId: etab.id } });
  const stockParProduit = new Map(stocks.map((s) => [s.produitId, s.quantiteTotale]));

  const resultat = axes.map((axe) => {
    const duAxe = requisitions.filter((r) => r.axeId === axe.id);
    const totaux = new Map();
    const commandes = duAxe.map((r) => {
      const lignes = r.lignes
        .filter((l) => l.quantiteValidee > 0)
        .map((l) => {
          const t = totaux.get(l.produitId) || { produitId: l.produitId, produit: l.produit.nom, quantite: 0 };
          t.quantite += l.quantiteValidee;
          totaux.set(l.produitId, t);
          return { produitId: l.produitId, produit: l.produit.nom, quantite: l.quantiteValidee };
        });
      return {
        id: r.id,
        numero: r.numero,
        destinataire: r.etablissementDemandeur ? r.etablissementDemandeur.nom : null,
        lignes,
      };
    });
    const totauxParProduit = Array.from(totaux.values())
      .map((t) => {
        const stockDisponible = stockParProduit.get(t.produitId) || 0;
        return { ...t, stockDisponible, suffisant: stockDisponible >= t.quantite };
      })
      .sort((a, b) => a.produit.localeCompare(b.produit));
    return {
      axe: {
        id: axe.id,
        nom: axe.nom,
        code: axe.code,
        frequenceJours: axe.frequenceJours === undefined ? null : axe.frequenceJours,
        dureeLivraisonJours: axe.dureeLivraisonJours === undefined ? null : axe.dureeLivraisonJours,
        dernierDepartAt: axe.dernierDepartAt || null,
        vehicule: axe.vehicule === undefined ? null : axe.vehicule,
        prochainDepart:
          axe.dernierDepartAt && axe.frequenceJours
            ? new Date(new Date(axe.dernierDepartAt).getTime() + axe.frequenceJours * 86400000)
            : null,
      },
      nombreCommandes: commandes.length,
      commandes,
      totauxParProduit,
    };
  });

  const infosAxes = await prisma.axe.findMany({
    select: {
      id: true,
      prochainDepartPrevu: true,
      drs: { select: { id: true, code: true, nom: true, ordreAxe: true }, orderBy: { ordreAxe: "asc" } },
    },
  });
  const infosParId = new Map(infosAxes.map((a) => [a.id, a]));
  const enrichi = resultat.map((r) => {
    const info = infosParId.get(r.axe.id);
    const prevu = info && info.prochainDepartPrevu ? info.prochainDepartPrevu : null;
    return {
      ...r,
      axe: { ...r.axe, prochainDepartPrevu: prevu, prochainDepart: prevu || r.axe.prochainDepart },
      wilayas: info ? info.drs : [],
      nombreDestinataires: new Set(r.commandes.map((c) => c.destinataire)).size,
    };
  });
  return res.json(enrichi);
}

// POST /distribution/:requisitionId/axe   body : { axeId } (axeId null = retirer l'axe)
async function associerAxe(req, res) {
  const etab = await exigerCamec(req, res);
  if (!etab) return undefined;

  const { requisitionId } = req.params;
  const { axeId } = req.body;

  const requisition = await prisma.requisition.findUnique({ where: { id: requisitionId } });
  if (!requisition || requisition.niveauActuelId !== etab.id || requisition.statut !== "VALIDEE") {
    return res.status(404).json({ erreur: "R\u00e9quisition introuvable parmi les commandes pr\u00eates \u00e0 exp\u00e9dier." });
  }

  if (axeId) {
    const axe = await prisma.axe.findUnique({ where: { id: axeId } });
    if (!axe || !axe.actif) {
      return res.status(400).json({ erreur: "Axe d'exp\u00e9dition introuvable ou inactif." });
    }
  }

  const misAJour = await prisma.requisition.update({
    where: { id: requisitionId },
    data: { axeId: axeId || null },
  });
  return res.json(misAJour);
}

// PUT /distribution/axes/:axeId/planning
// body : { frequenceJours, dureeLivraisonJours, vehicule, prochainDepartPrevu } (champs facultatifs, null = effacer)
async function modifierPlanningAxe(req, res) {
  const etab = await exigerCamec(req, res);
  if (!etab) return undefined;

  const { axeId } = req.params;
  const corps = req.body || {};
  const data = {};

  function entier(valeur, max) {
    if (valeur === null || valeur === "") return null;
    const n = Number(valeur);
    return Number.isInteger(n) && n > 0 && n <= max ? n : undefined;
  }

  if ("frequenceJours" in corps) {
    const v = entier(corps.frequenceJours, 366);
    if (v === undefined) return res.status(400).json({ erreur: "Frequence invalide (nombre de jours entre 1 et 366)." });
    data.frequenceJours = v;
  }
  if ("dureeLivraisonJours" in corps) {
    const v = entier(corps.dureeLivraisonJours, 90);
    if (v === undefined) return res.status(400).json({ erreur: "Duree invalide (nombre de jours entre 1 et 90)." });
    data.dureeLivraisonJours = v;
  }
  if ("vehicule" in corps) {
    const v = corps.vehicule === "" ? null : corps.vehicule;
    if (v !== null && !["MINIBUS", "CAMION", "AMBULANCE", "AUTRE"].includes(v)) {
      return res.status(400).json({ erreur: "Vehicule invalide (MINIBUS, CAMION, AMBULANCE ou AUTRE)." });
    }
    data.vehicule = v;
  }
  if ("prochainDepartPrevu" in corps) {
    if (corps.prochainDepartPrevu === null || corps.prochainDepartPrevu === "") {
      data.prochainDepartPrevu = null;
    } else {
      const d = new Date(corps.prochainDepartPrevu);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ erreur: "Date de depart invalide." });
      data.prochainDepartPrevu = d;
    }
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ erreur: "Aucune modification fournie." });
  }

  const axe = await prisma.axe.findUnique({ where: { id: axeId } });
  if (!axe) return res.status(404).json({ erreur: "Axe d'expedition introuvable." });

  const misAJour = await prisma.axe.update({ where: { id: axeId }, data });
  return res.json(misAJour);
}

// POST /distribution/axes/:axeId/expedier
// Depart de l'axe : livre chaque commande associee (meme chemin que generer-bl).
// Une commande qui reste VALIDEE apres coup (reliquat faute de stock) est
// detachee de l'axe et retourne dans la liste des commandes pretes.
async function expedierAxe(req, res) {
  const etab = await exigerCamec(req, res);
  if (!etab) return undefined;

  const { utilisateurId } = req.utilisateur;
  const { axeId } = req.params;

  const axe = await prisma.axe.findUnique({ where: { id: axeId } });
  if (!axe) return res.status(404).json({ erreur: "Axe d'exp\u00e9dition introuvable." });

  const requisitions = await prisma.requisition.findMany({
    where: { niveauActuelId: etab.id, statut: "VALIDEE", axeId },
    orderBy: { numero: "asc" },
  });
  if (requisitions.length === 0) {
    return res.status(400).json({ erreur: "Aucune commande n'est associ\u00e9e \u00e0 cet axe." });
  }

  const rapport = [];
  for (const r of requisitions) {
    try {
      const resultat = await executerValidationOuModification({
        etablissementId: etab.id,
        utilisateurId,
        requisitionId: r.id,
        decision: "valider",
        lignes: null,
      });
      const apres = await prisma.requisition.findUnique({ where: { id: r.id } });
      let reliquat = false;
      if (apres && apres.statut === "VALIDEE") {
        reliquat = true;
        await prisma.requisition.update({ where: { id: r.id }, data: { axeId: null } });
      }
      rapport.push({ numero: r.numero, expedie: Boolean(resultat.bordereauLivraison), reliquat });
    } catch (erreur) {
      if (erreur instanceof ErreurMetier) {
        rapport.push({ numero: r.numero, expedie: false, reliquat: false, erreur: erreur.message });
      } else {
        console.error("Erreur lors du depart de l'axe :", erreur);
        rapport.push({ numero: r.numero, expedie: false, reliquat: false, erreur: "Erreur serveur." });
      }
    }
  }

  if (rapport.some((x) => x.expedie)) {
    await prisma.axe.update({ where: { id: axe.id }, data: { dernierDepartAt: new Date(), prochainDepartPrevu: axe.frequenceJours ? new Date(Date.now() + axe.frequenceJours * 86400000) : null } });
  }

  return res.json({ axe: { id: axe.id, nom: axe.nom }, rapport });
}

// GET /distribution/axes/ma-region
// Lecture seule pour la DRS et la SAMEC (depot regional) : l'axe qui dessert leur region,
// son planning et l'etat de leurs commandes validees a la CAMEC.
async function axesMaRegion(req, res) {
  try {
    const role = req.utilisateur.role;
    if (role !== "GESTIONNAIRE_DRS" && role !== "DIRECTEUR_DRS") {
      return res.status(403).json({ erreur: "Cette vue est r\u00e9serv\u00e9e aux comptes de la DRS et de la SAMEC." });
    }
    const etab = await prisma.etablissement.findUnique({ where: { id: req.utilisateur.etablissementId } });
    if (!etab || !etab.drsId) {
      return res.status(400).json({ erreur: "Votre compte n'est rattach\u00e9 \u00e0 aucune r\u00e9gion." });
    }
    const lignesDrs = await prisma.$queryRawUnsafe("SELECT id, nom, axe_id FROM drs WHERE id = $1", etab.drsId);
    if (lignesDrs.length !== 1) {
      return res.status(404).json({ erreur: "R\u00e9gion introuvable." });
    }
    const drs = lignesDrs[0];

    const camec = await prisma.etablissement.findFirst({ where: { type: "CAMEC" } });
    const requisitions = camec
      ? await prisma.requisition.findMany({
          where: { niveauActuelId: camec.id, statut: "VALIDEE", etablissementDemandeur: { drsId: etab.drsId } },
          include: { lignes: { include: { produit: true } }, etablissementDemandeur: true },
          orderBy: { numero: "asc" },
        })
      : [];

    let axe = null;
    if (drs.axe_id) {
      axe = await prisma.axe.findUnique({
        where: { id: drs.axe_id },
        include: { drs: { select: { id: true, code: true, nom: true, ordreAxe: true }, orderBy: { ordreAxe: "asc" } } },
      });
    }

    const commandes = requisitions.map((r) => ({
      id: r.id,
      numero: r.numero,
      destinataire: r.etablissementDemandeur ? r.etablissementDemandeur.nom : null,
      sur_cet_axe: !!axe && r.axeId === axe.id,
      sans_axe: !r.axeId,
      lignes: r.lignes
        .filter((l) => l.quantiteValidee > 0)
        .map((l) => ({ produit: l.produit.nom, quantite: l.quantiteValidee })),
    }));
    const enAttenteSansAxe = commandes.filter((c) => c.sans_axe).length;

    if (!axe) {
      return res.json({ region: { id: drs.id, nom: drs.nom }, axe: null, wilayas: [], commandes, enAttenteSansAxe });
    }

    const prochainDepart = axe.prochainDepartPrevu
      ? axe.prochainDepartPrevu
      : axe.dernierDepartAt && axe.frequenceJours
        ? new Date(new Date(axe.dernierDepartAt).getTime() + axe.frequenceJours * 86400000)
        : null;

    return res.json({
      region: { id: drs.id, nom: drs.nom },
      axe: {
        id: axe.id,
        nom: axe.nom,
        code: axe.code,
        frequenceJours: axe.frequenceJours === undefined ? null : axe.frequenceJours,
        dureeLivraisonJours: axe.dureeLivraisonJours === undefined ? null : axe.dureeLivraisonJours,
        dernierDepartAt: axe.dernierDepartAt || null,
        vehicule: axe.vehicule === undefined ? null : axe.vehicule,
        prochainDepart: prochainDepart,
      },
      wilayas: axe.drs.map((d) => ({ id: d.id, code: d.code, nom: d.nom, ordreAxe: d.ordreAxe, maRegion: d.id === drs.id })),
      commandes,
      enAttenteSansAxe,
    });
  } catch (erreur) {
    console.error("Erreur axes ma-region :", erreur);
    return res.status(500).json({ erreur: "Erreur lors de la lecture de l'axe de la r\u00e9gion." });
  }
}

module.exports = {
  compterEnvoyesEnAttente,
  modifierPlanningAxe,
  listerPretesAExpedier,
  genererBl,
  listerEnAttenteReception,
  confirmerReception,
  listerAxes,
  axesMaRegion,
  resumeParAxe,
  associerAxe,
  expedierAxe,
};