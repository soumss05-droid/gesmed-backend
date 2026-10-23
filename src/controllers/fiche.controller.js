const prisma = require("../config/prisma");
const { perimetreEtablissementIds } = require("./stocks.controller");

const JOUR = 24 * 60 * 60 * 1000;
const STATUTS_OUVERTS = ["EN_ATTENTE", "MODIFIEE_EN_ATTENTE_CONFIRMATION", "REJETEE_POUR_CORRECTION", "VALIDEE", "EXPEDIEE"];
const STATUTS_A_SUIVRE_RETARD = ["EN_ATTENTE", "MODIFIEE_EN_ATTENTE_CONFIRMATION", "VALIDEE", "EXPEDIEE"];
const SEUIL_RETARD_JOURS = 7;

function arrondir(valeur, decimales = 1) {
  const f = Math.pow(10, decimales);
  return Math.round(valeur * f) / f;
}

function variation(courant, precedent) {
  if (!precedent) return null;
  return arrondir(((courant - precedent) / precedent) * 100);
}

function cleSerie(date, parMois) {
  const iso = date.toISOString();
  return parMois ? iso.slice(0, 7) : iso.slice(0, 10);
}

// GET /rapports/fiche-situation?jours=90  ou  ?dateDebut=YYYY-MM-DD&dateFin=YYYY-MM-DD
// Synthese en temps reel du perimetre reel du role connecte (meme logique que les autres rapports).
async function ficheSituation(req, res) {
  try {
    const { etablissementId, role } = req.utilisateur;
    const maintenant = new Date();
    const jours = Math.min(Math.max(parseInt(req.query.jours, 10) || 90, 7), 365);
    const fin = req.query.dateFin ? new Date(req.query.dateFin + "T23:59:59") : maintenant;
    const debut = req.query.dateDebut ? new Date(req.query.dateDebut) : new Date(fin.getTime() - jours * JOUR);
    if (isNaN(debut.getTime()) || isNaN(fin.getTime()) || debut >= fin) {
      return res.status(400).json({ erreur: "P\u00e9riode invalide." });
    }

    const duree = fin.getTime() - debut.getTime();
    const debutPrec = new Date(debut.getTime() - duree);
    const ilYA90 = new Date(maintenant.getTime() - 90 * JOUR);
    const depart = debutPrec < ilYA90 ? debutPrec : ilYA90;
    const dansTroisMois = new Date(maintenant.getTime() + 90 * JOUR);
    const parMois = duree > 62 * JOUR;

    const ids = await perimetreEtablissementIds(etablissementId, role);
    const filtreEtab = ids ? { etablissementId: { in: ids } } : {};
    const filtreRequisitions = ids
      ? { OR: [{ etablissementDemandeurId: { in: ids } }, { niveauActuelId: etablissementId }] }
      : {};

    const [structure, stocks, mouvements, lotsAVenir, lotsPerimes, requisitions] = await Promise.all([
      etablissementId
        ? prisma.etablissement.findUnique({ where: { id: etablissementId }, select: { nom: true, type: true } })
        : Promise.resolve(null),
      prisma.stock.findMany({
        where: filtreEtab,
        include: {
          produit: { select: { id: true, nom: true, unite: true } },
          etablissement: { select: { id: true, nom: true, type: true } },
        },
      }),
      prisma.mouvementStock.findMany({
        where: {
          dateMouvement: { gte: depart },
          type: { in: ["ENTREE", "SORTIE"] },
          lot: filtreEtab,
        },
        select: {
          type: true,
          quantite: true,
          dateMouvement: true,
          referenceType: true,
          lot: { select: { produitId: true, prixUnitaire: true } },
        },
      }),
      prisma.lot.findMany({
        where: { ...filtreEtab, quantite: { gt: 0 }, datePeremption: { gte: maintenant, lte: dansTroisMois } },
        include: { produit: { select: { nom: true } }, etablissement: { select: { nom: true } } },
        orderBy: { datePeremption: "asc" },
        take: 500,
      }),
      prisma.lot.findMany({
        where: { ...filtreEtab, quantite: { gt: 0 }, datePeremption: { lt: maintenant } },
        include: { produit: { select: { nom: true } }, etablissement: { select: { nom: true } } },
        orderBy: { datePeremption: "asc" },
        take: 500,
      }),
      prisma.requisition.findMany({
        where: {
          AND: [
            filtreRequisitions,
            { OR: [{ statut: { in: STATUTS_OUVERTS } }, { statut: "CLOTUREE", dateDerniereMaj: { gte: debut } }] },
          ],
        },
        select: {
          id: true,
          numero: true,
          statut: true,
          dateCreation: true,
          dateDerniereMaj: true,
          etablissementDemandeur: { select: { nom: true } },
          niveauActuel: { select: { nom: true } },
        },
        take: 500,
      }),
    ]);

    // ---------- Flux de la periode (et periode precedente de meme duree) ----------
    let conso = 0, consoPrec = 0, entrees = 0, entreesPrec = 0, pertes = 0, pertesPrec = 0, valeurPertes = 0;
    const conso90 = new Map();
    const mapSerie = {};

    for (const m of mouvements) {
      const d = m.dateMouvement;
      const q = m.quantite;
      const estDispensation = m.type === "SORTIE" && m.referenceType === "DISPENSATION";
      const estDestruction = m.type === "SORTIE" && m.referenceType === "DESTRUCTION";
      const estEntree = m.type === "ENTREE";

      if (estDispensation && d >= ilYA90) {
        conso90.set(m.lot.produitId, (conso90.get(m.lot.produitId) || 0) + q);
      }

      if (d >= debut && d <= fin) {
        const k = cleSerie(d, parMois);
        if (!mapSerie[k]) mapSerie[k] = { dispensations: 0, entrees: 0 };
        if (estDispensation) {
          conso += q;
          mapSerie[k].dispensations += q;
        } else if (estEntree) {
          entrees += q;
          mapSerie[k].entrees += q;
        } else if (estDestruction) {
          pertes += q;
          valeurPertes += q * Number(m.lot.prixUnitaire || 0);
        }
      } else if (d >= debutPrec && d < debut) {
        if (estDispensation) consoPrec += q;
        else if (estEntree) entreesPrec += q;
        else if (estDestruction) pertesPrec += q;
      }
    }

    const serie = [];
    const curseur = new Date(debut);
    if (parMois) curseur.setUTCDate(1);
    while (curseur <= fin) {
      const k = cleSerie(curseur, parMois);
      serie.push({ periode: k, dispensations: (mapSerie[k] || {}).dispensations || 0, entrees: (mapSerie[k] || {}).entrees || 0 });
      if (parMois) curseur.setUTCMonth(curseur.getUTCMonth() + 1);
      else curseur.setUTCDate(curseur.getUTCDate() + 1);
    }

    // ---------- Situation du stock par produit ----------
    const parProduit = new Map();
    for (const s of stocks) {
      const p = parProduit.get(s.produitId) || {
        produitId: s.produitId,
        produit: s.produit.nom,
        unite: s.produit.unite,
        stock: 0,
        seuilMin: 0,
        structures: 0,
        enRupture: 0,
        sousSeuil: 0,
        joursRuptureMax: null,
      };
      p.stock += s.quantiteTotale;
      p.seuilMin += s.seuilMin;
      p.structures += 1;
      if (s.statut === "RUPTURE") {
        p.enRupture += 1;
        if (s.derniereMajStatut) {
          const joursRupture = Math.max(0, Math.floor((maintenant.getTime() - new Date(s.derniereMajStatut).getTime()) / JOUR));
          if (p.joursRuptureMax === null || joursRupture > p.joursRuptureMax) p.joursRuptureMax = joursRupture;
        }
      } else if (s.statut === "SOUS_SEUIL") p.sousSeuil += 1;
      parProduit.set(s.produitId, p);
    }

    const produits = [...parProduit.values()].map((p) => {
      const consoMensuelle = (conso90.get(p.produitId) || 0) / 3;
      const moisStock = consoMensuelle > 0 ? arrondir(p.stock / consoMensuelle) : null;
      const statut =
        p.enRupture === p.structures ? "RUPTURE"
        : p.enRupture > 0 ? "RUPTURE_PARTIELLE"
        : p.sousSeuil > 0 ? "SOUS_SEUIL"
        : "NORMAL";
      const alerte = statut === "RUPTURE" || (moisStock !== null && moisStock < 1) ? "CRITIQUE"
        : statut !== "NORMAL" || (moisStock !== null && moisStock < 3) ? "ATTENTION"
        : "OK";
      return { ...p, consoMensuelle: arrondir(consoMensuelle), moisStock, statut, alerte };
    });

    const ordreAlerte = { CRITIQUE: 0, ATTENTION: 1, OK: 2 };
    produits.sort((a, b) => {
      if (ordreAlerte[a.alerte] !== ordreAlerte[b.alerte]) return ordreAlerte[a.alerte] - ordreAlerte[b.alerte];
      const ma = a.moisStock === null ? Infinity : a.moisStock;
      const mb = b.moisStock === null ? Infinity : b.moisStock;
      return ma - mb;
    });

    const lignesTotal = stocks.length;
    const lignesRupture = stocks.filter((s) => s.statut === "RUPTURE").length;
    const lignesSousSeuil = stocks.filter((s) => s.statut === "SOUS_SEUIL").length;
    const tauxDisponibilite = lignesTotal > 0 ? arrondir(100 * (1 - lignesRupture / lignesTotal)) : null;

    // ---------- Etablissements a risque (seulement si le perimetre en contient plusieurs) ----------
    const parEtab = new Map();
    for (const s of stocks) {
      const e = parEtab.get(s.etablissementId) || {
        etablissementId: s.etablissementId,
        nom: s.etablissement.nom,
        type: s.etablissement.type,
        lignes: 0,
        ruptures: 0,
        sousSeuil: 0,
      };
      e.lignes += 1;
      if (s.statut === "RUPTURE") e.ruptures += 1;
      else if (s.statut === "SOUS_SEUIL") e.sousSeuil += 1;
      parEtab.set(s.etablissementId, e);
    }
    const etablissementsARisque =
      parEtab.size > 1
        ? [...parEtab.values()]
            .filter((e) => e.ruptures > 0 || e.sousSeuil > 0)
            .map((e) => ({ ...e, tauxDisponibilite: arrondir(100 * (1 - e.ruptures / e.lignes)) }))
            .sort((a, b) => b.ruptures - a.ruptures || a.tauxDisponibilite - b.tauxDisponibilite || b.sousSeuil - a.sousSeuil)
            .slice(0, 15)
        : [];

    // ---------- Peremptions ----------
    const formaterLot = (l) => ({
      produit: l.produit.nom,
      numeroLot: l.numeroLot,
      quantite: l.quantite,
      etablissement: l.etablissement.nom,
      datePeremption: l.datePeremption,
    });
    const perimesQuantite = lotsPerimes.reduce((t, l) => t + l.quantite, 0);
    const aVenirQuantite = lotsAVenir.reduce((t, l) => t + l.quantite, 0);

    // ---------- Requisitions ----------
    const parStatut = {};
    const enRetard = [];
    const delais = [];
    let ouvertes = 0;
    for (const r of requisitions) {
      parStatut[r.statut] = (parStatut[r.statut] || 0) + 1;
      const age = Math.floor((maintenant.getTime() - r.dateCreation.getTime()) / JOUR);
      if (r.statut === "CLOTUREE") {
        delais.push((r.dateDerniereMaj.getTime() - r.dateCreation.getTime()) / JOUR);
      } else {
        ouvertes += 1;
        if (STATUTS_A_SUIVRE_RETARD.includes(r.statut) && age > SEUIL_RETARD_JOURS) {
          enRetard.push({
            numero: r.numero,
            statut: r.statut,
            demandeur: r.etablissementDemandeur.nom,
            niveauActuel: r.niveauActuel ? r.niveauActuel.nom : null,
            ageJours: age,
          });
        }
      }
    }
    enRetard.sort((a, b) => b.ageJours - a.ageJours);
    const delaiMoyenJours = delais.length > 0 ? arrondir(delais.reduce((t, v) => t + v, 0) / delais.length) : null;

    // ---------- Points a traiter ----------
    const noms = (liste) => liste.slice(0, 5).map((p) => p.produit).join(", ");
    const produitsRupture = produits.filter((p) => p.statut === "RUPTURE" || p.statut === "RUPTURE_PARTIELLE");
    const produitsMoinsUnMois = produits.filter((p) => p.statut !== "RUPTURE" && p.moisStock !== null && p.moisStock < 1);
    const produitsSousSeuil = produits.filter((p) => p.statut === "SOUS_SEUIL");

    const pointsATraiter = [];
    if (produitsRupture.length > 0) {
      pointsATraiter.push({
        gravite: "CRITIQUE",
        domaine: "Stock",
        texte: `${produitsRupture.length} produit(s) en rupture (${lignesRupture} ligne(s) de stock)`,
        detail: noms(produitsRupture),
      });
    }
    if (produitsMoinsUnMois.length > 0) {
      pointsATraiter.push({
        gravite: "CRITIQUE",
        domaine: "Stock",
        texte: `${produitsMoinsUnMois.length} produit(s) avec moins d'un mois de stock`,
        detail: noms(produitsMoinsUnMois),
      });
    }
    if (lotsPerimes.length > 0) {
      pointsATraiter.push({
        gravite: "CRITIQUE",
        domaine: "P\u00e9remptions",
        texte: `${lotsPerimes.length} lot(s) p\u00e9rim\u00e9(s) encore en stock (${perimesQuantite} unit\u00e9s) \u00e0 d\u00e9truire`,
        detail: null,
      });
    }
    if (produitsSousSeuil.length > 0) {
      pointsATraiter.push({
        gravite: "ATTENTION",
        domaine: "Stock",
        texte: `${produitsSousSeuil.length} produit(s) sous le seuil minimum`,
        detail: noms(produitsSousSeuil),
      });
    }
    if (lotsAVenir.length > 0) {
      pointsATraiter.push({
        gravite: "ATTENTION",
        domaine: "P\u00e9remptions",
        texte: `${lotsAVenir.length} lot(s) p\u00e9riment sous 3 mois (${aVenirQuantite} unit\u00e9s)`,
        detail: null,
      });
    }
    if (enRetard.length > 0) {
      pointsATraiter.push({
        gravite: enRetard.length >= 5 ? "CRITIQUE" : "ATTENTION",
        domaine: "R\u00e9quisitions",
        texte: `${enRetard.length} r\u00e9quisition(s) en attente depuis plus de ${SEUIL_RETARD_JOURS} jours`,
        detail: null,
      });
    }

    const produitsRuptureLongue = produits
      .filter((p) => p.joursRuptureMax !== null && p.joursRuptureMax > 30)
      .sort((a, b) => b.joursRuptureMax - a.joursRuptureMax);
    if (produitsRuptureLongue.length > 0) {
      pointsATraiter.push({
        gravite: "CRITIQUE",
        domaine: "Stock",
        texte: produitsRuptureLongue.length + " produit(s) en rupture depuis plus de 30 jours",
        detail: produitsRuptureLongue.slice(0, 5).map((p) => p.produit + " (" + p.joursRuptureMax + " j)").join(", "),
      });
    }

    // Stock tres superieur a la consommation (seulement si la consommation est connue)
    const produitsSurstock = produits
      .filter((p) => p.moisStock !== null && p.moisStock > 24)
      .sort((a, b) => b.moisStock - a.moisStock);
    if (produitsSurstock.length > 0) {
      pointsATraiter.push({
        gravite: "ATTENTION",
        domaine: "Stock",
        texte: produitsSurstock.length + " produit(s) avec un stock très supérieur à la consommation (plus de 24 mois)",
        detail: produitsSurstock
          .slice(0, 5)
          .map((p) => p.produit + " (" + (p.moisStock > 99 ? ">99" : String(p.moisStock).replace(".", ",")) + " mois)")
          .join(", ") + ". À vérifier : surstock possible, péremption à surveiller.",
      });
    }

    // ---------- Offre de service (scores ponderes par le poids de chaque service) ----------
    const pctOffre = (n, d) => (d > 0 ? Math.round((n * 1000) / d) / 10 : null);
    const fosas = await prisma.etablissement.findMany({
      where: { type: "FORMATION_SANITAIRE", actif: true, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, nom: true },
    });
    const fosaIds = fosas.map((f) => f.id);
    const [servicesActifs, offresServices, eligibilitesServices] =
      fosaIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            prisma.serviceProgramme.findMany({
              where: { actif: true },
              select: { id: true, poids: true, programme: { select: { code: true, nom: true } } },
            }),
            prisma.offreService.findMany({
              where: { etablissementId: { in: fosaIds } },
              select: { serviceId: true, etablissementId: true, offert: true, valeurValidee: true, valideeLe: true, updatedAt: true },
            }),
            prisma.eligibiliteService.findMany({
              where: { etablissementId: { in: fosaIds } },
              select: { serviceId: true, etablissementId: true },
            }),
          ]);

    const offresParFosa = new Map();
    for (const o of offresServices) {
      if (!offresParFosa.has(o.etablissementId)) offresParFosa.set(o.etablissementId, new Map());
      offresParFosa.get(o.etablissementId).set(o.serviceId, o);
    }
    const eligiblesParFosa = new Map();
    for (const e of eligibilitesServices) {
      if (!eligiblesParFosa.has(e.etablissementId)) eligiblesParFosa.set(e.etablissementId, new Set());
      eligiblesParFosa.get(e.etablissementId).add(e.serviceId);
    }

    const cumulOff = { num: 0, el: 0, tot: 0 };
    const cumulProv = { num: 0, el: 0, tot: 0 };
    const parProgrammeOffre = new Map();
    const scoresFosa = [];
    let reponsesEnAttente = 0;
    let servicesNonRenseignes = 0;

    for (const f of fosas) {
      const offresF = offresParFosa.get(f.id) || new Map();
      const eligF = eligiblesParFosa.get(f.id) || new Set();
      const c = { num: 0, el: 0 };
      for (const s of servicesActifs) {
        const poids = s.poids || 1;
        const offre = offresF.get(s.id);
        const eligible = eligF.has(s.id);
        const enAttente = offre ? !offre.valideeLe || offre.updatedAt > offre.valideeLe : false;
        const officiel = offre ? offre.valeurValidee : null;
        const provisoire = offre ? (enAttente ? offre.offert : officiel) : false;
        let prog = parProgrammeOffre.get(s.programme.code);
        if (!prog) {
          prog = { code: s.programme.code, nom: s.programme.nom, num: 0, el: 0, tot: 0 };
          parProgrammeOffre.set(s.programme.code, prog);
        }
        cumulOff.tot += poids;
        cumulProv.tot += poids;
        prog.tot += poids;
        if (enAttente) reponsesEnAttente += 1;
        if (eligible) {
          cumulOff.el += poids;
          cumulProv.el += poids;
          prog.el += poids;
          c.el += poids;
          if (!offre) servicesNonRenseignes += 1;
          if (officiel === true) {
            cumulOff.num += poids;
            prog.num += poids;
            c.num += poids;
          }
          if (provisoire === true) cumulProv.num += poids;
        }
      }
      if (c.el > 0) {
        scoresFosa.push({ etablissementId: f.id, nom: f.nom, couverture: pctOffre(c.num, c.el), points: c.num, pointsEligibles: c.el });
      }
    }

    const resumeScore = (c) => ({
      points: c.num,
      pointsEligibles: c.el,
      pointsTotal: c.tot,
      couvertureEligibles: pctOffre(c.num, c.el),
      couvertureTotale: pctOffre(c.num, c.tot),
    });

    const offreService = {
      nbFosa: fosas.length,
      nbServices: servicesActifs.length,
      officiel: resumeScore(cumulOff),
      provisoire: resumeScore(cumulProv),
      reponsesEnAttente,
      servicesNonRenseignes,
      parProgramme: [...parProgrammeOffre.values()].map((p) => ({
        code: p.code,
        nom: p.nom,
        couvertureEligibles: pctOffre(p.num, p.el),
        couvertureTotale: pctOffre(p.num, p.tot),
      })),
      fosasFaibles: fosas.length > 1 ? scoresFosa.sort((a, b) => a.couverture - b.couverture).slice(0, 10) : [],
    };

    if (reponsesEnAttente > 0) {
      pointsATraiter.push({
        gravite: "ATTENTION",
        domaine: "Offre de service",
        texte: reponsesEnAttente + " réponse(s) en attente de validation du Médecin chef",
        detail: null,
      });
    }
    if (servicesNonRenseignes > 0) {
      pointsATraiter.push({
        gravite: "ATTENTION",
        domaine: "Offre de service",
        texte: servicesNonRenseignes + " service(s) éligible(s) non renseigné(s)",
        detail: null,
      });
    }
    if (offreService.officiel.couvertureEligibles !== null && offreService.officiel.couvertureEligibles < 50) {
      pointsATraiter.push({
        gravite: "CRITIQUE",
        domaine: "Offre de service",
        texte: "Couverture officielle faible : " + String(offreService.officiel.couvertureEligibles).replace(".", ",") + " % des services éligibles",
        detail: null,
      });
    }

    // ---------- Performance de gestion (indice sur 100, composantes visibles) ----------
    const stockTotalUnites = stocks.reduce((t, s) => t + s.quantiteTotale, 0);
    const compPeremptions =
      stockTotalUnites > 0
        ? Math.max(0, arrondir(100 * (1 - perimesQuantite / stockTotalUnites)))
        : lotsPerimes.length > 0
        ? 0
        : 100;
    const compRequisitions = ouvertes > 0 ? arrondir(100 * (1 - enRetard.length / ouvertes)) : 100;
    const produitsAvecConso = produits.filter((p) => (conso90.get(p.produitId) || 0) > 0).length;
    const compSuivi = produits.length > 0 ? arrondir((100 * produitsAvecConso) / produits.length) : null;
    const composantes = [
      { code: "DISPONIBILITE", libelle: "Disponibilité des produits", poids: 40, score: tauxDisponibilite },
      { code: "PEREMPTIONS", libelle: "Maîtrise des péremptions", poids: 20, score: compPeremptions },
      { code: "REQUISITIONS", libelle: "Respect des délais de réquisition", poids: 25, score: compRequisitions },
      { code: "SUIVI", libelle: "Suivi de la consommation", poids: 15, score: compSuivi },
    ];
    const utilisables = composantes.filter((c) => c.score !== null);
    const poidsUtilises = utilisables.reduce((t, c) => t + c.poids, 0);
    const indiceGestion =
      poidsUtilises > 0 ? arrondir(utilisables.reduce((t, c) => t + c.score * c.poids, 0) / poidsUtilises) : null;
    const performanceGestion = { indice: indiceGestion, composantes };

    // ---------- Synthese ----------
    const feux = [
      {
        domaine: "Disponibilit\u00e9 des produits",
        etat: tauxDisponibilite === null ? "GRIS" : tauxDisponibilite >= 95 ? "VERT" : tauxDisponibilite >= 80 ? "ORANGE" : "ROUGE",
        valeur: tauxDisponibilite === null ? null : tauxDisponibilite + " %",
      },
      {
        domaine: "P\u00e9remptions",
        etat: lotsPerimes.length > 0 ? "ROUGE" : lotsAVenir.length > 0 ? "ORANGE" : "VERT",
        valeur: lotsPerimes.length + " p\u00e9rim\u00e9(s), " + lotsAVenir.length + " sous 3 mois",
      },
      {
        domaine: "R\u00e9quisitions",
        etat: enRetard.length >= 5 ? "ROUGE" : enRetard.length > 0 ? "ORANGE" : "VERT",
        valeur: enRetard.length + " en retard sur " + ouvertes + " en cours",
      },
    ];

    feux.push({
      domaine: "Offre de service",
      etat:
        offreService.officiel.couvertureEligibles === null
          ? "GRIS"
          : offreService.officiel.couvertureEligibles >= 80
          ? "VERT"
          : offreService.officiel.couvertureEligibles >= 50
          ? "ORANGE"
          : "ROUGE",
      valeur:
        offreService.officiel.couvertureEligibles === null
          ? "Aucune réponse validée"
          : String(offreService.officiel.couvertureEligibles).replace(".", ",") + " % (officiel)",
    });
    feux.push({
      domaine: "Performance de gestion",
      etat: performanceGestion.indice === null ? "GRIS" : performanceGestion.indice >= 75 ? "VERT" : performanceGestion.indice >= 50 ? "ORANGE" : "ROUGE",
      valeur: performanceGestion.indice === null ? null : String(performanceGestion.indice).replace(".", ",") + " / 100",
    });

    const phrases = [];
    if (lignesTotal === 0) phrases.push("Aucun stock enregistr\u00e9 pour ce p\u00e9rim\u00e8tre.");
    else {
      phrases.push(`Disponibilit\u00e9 de ${tauxDisponibilite} % (${lignesRupture} rupture(s) sur ${lignesTotal} lignes de stock).`);
      if (produitsMoinsUnMois.length > 0) phrases.push(`${produitsMoinsUnMois.length} produit(s) \u00e0 moins d'un mois de stock.`);
      if (lotsPerimes.length > 0) phrases.push(`${lotsPerimes.length} lot(s) p\u00e9rim\u00e9(s) \u00e0 d\u00e9truire.`);
      if (enRetard.length > 0) phrases.push(`${enRetard.length} r\u00e9quisition(s) en retard.`);
      if (pointsATraiter.length === 0) phrases.push("Aucun point critique \u00e0 signaler.");
    }

    const dureesRupture = produits.filter((p) => p.enRupture > 0 && p.joursRuptureMax !== null && p.joursRuptureMax !== undefined).map((p) => p.joursRuptureMax);
    const ruptureDuree = {
      produitsEnRupture: produits.filter((p) => p.enRupture > 0).length,
      avecDate: dureesRupture.length,
      joursMax: dureesRupture.length > 0 ? Math.max(...dureesRupture) : null,
      joursMoyen: dureesRupture.length > 0 ? arrondir(dureesRupture.reduce((t, v) => t + v, 0) / dureesRupture.length) : null,
      plusDe30Jours: dureesRupture.filter((d) => d > 30).length,
    };
    if (ruptureDuree.joursMax !== null) {
      phrases.push("Rupture la plus longue : " + ruptureDuree.joursMax + " jour(s).");
    }

    if (offreService.officiel.couvertureEligibles !== null) {
      phrases.push("Offre de service : " + String(offreService.officiel.couvertureEligibles).replace(".", ",") + " % (officiel).");
    }
    if (performanceGestion.indice !== null) {
      phrases.push("Performance de gestion : " + String(performanceGestion.indice).replace(".", ",") + " / 100.");
    }

    return res.json({
      entete: {
        structure: structure ? structure.nom : null,
        niveau: structure ? structure.type : null,
        role,
        debut,
        fin,
        debutPrecedente: debutPrec,
        editeLe: maintenant,
        nbStructures: parEtab.size,
      },
      synthese: { feux, conclusion: phrases.join(" ") },
      indicateurs: {
        tauxDisponibilite,
        lignesTotal,
        lignesRupture,
        lignesSousSeuil,
        produitsSuivis: produits.length,
        consommation: { valeur: conso, precedente: consoPrec, variationPct: variation(conso, consoPrec) },
        entrees: { valeur: entrees, precedente: entreesPrec, variationPct: variation(entrees, entreesPrec) },
        pertes: {
          valeur: pertes,
          precedente: pertesPrec,
          variationPct: variation(pertes, pertesPrec),
          valeurMonetaire: arrondir(valeurPertes, 0),
        },
        delaiMoyenRequisitionJours: delaiMoyenJours,
        rupture: ruptureDuree,
      },
      serie: { pas: parMois ? "MOIS" : "JOUR", points: serie },
      produits,
      etablissementsARisque,
      peremptions: {
        perimesNonDetruits: { nbLots: lotsPerimes.length, quantite: perimesQuantite, lots: lotsPerimes.slice(0, 20).map(formaterLot) },
        sousTroisMois: { nbLots: lotsAVenir.length, quantite: aVenirQuantite, lots: lotsAVenir.slice(0, 20).map(formaterLot) },
      },
      requisitions: { parStatut, ouvertes, enRetard: enRetard.slice(0, 15), nbEnRetard: enRetard.length, seuilRetardJours: SEUIL_RETARD_JOURS },
      pointsATraiter,
      offreService,
      performanceGestion,
    });
  } catch (erreur) {
    console.error("Erreur fiche de situation :", erreur);
    return res.status(500).json({ erreur: "Impossible de calculer la fiche de situation." });
  }
}

module.exports = { ficheSituation };