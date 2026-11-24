// GET /stocks/carte?produitId=...
// Donnees de la carte du stock : une ligne par formation sanitaire (avec GPS, statut du stock,
// CMM, couverture en mois et peremptions pour le produit choisi) + syntheses par wilaya et moughataa.
// CMM = sorties par dispensation des 6 derniers mois / 6 (meme regle que GET /stocks/cmm,
// dispensations annulees exclues).
// Performance de gestion (par moughataa) = DMM du depot de la moughataa (sorties par BL des 6 derniers
// mois / 6) - somme des CMM de ses formations ; meme regle que GET /stocks/performance-moughataa,
// mais calculee en requetes groupees. Reservee au national, aux DRS et aux responsables de moughataa (leur moughataa seulement).
// La couverture en service est fournie par GET /couverture-offre (non recalculee ici).
// LECTURE SEULE. Portee selon le role :
//   national (CAMEC, GAS Programme national, ADMIN) : tout le pays
//   DRS (GESTIONNAIRE_DRS, DIRECTEUR_DRS)           : sa wilaya
//   moughataa (GAS_MOUGHATAA, MEDECIN_CHEF_MOUGHATAA) : sa moughataa
const prisma = require("../config/prisma");
const { idsDispensationsAnnulees } = require("./dispensationsAnnulees.helper");

const ROLES_NATIONAL = ["GESTIONNAIRE_CAMEC", "GAS_PROGRAMME_NATIONAL", "ADMIN"];
const ROLES_DRS = ["GESTIONNAIRE_DRS", "DIRECTEUR_DRS"];
const ROLES_MOUGHATAA = ["GAS_MOUGHATAA", "MEDECIN_CHEF_MOUGHATAA"];
const STATUTS = ["RUPTURE", "SOUS_SEUIL", "NORMAL", "SURSTOCK", "SANS_STOCK"];

const JOURS_PEREMPTION = 90;

function compteurVide() {
  return { total: 0, RUPTURE: 0, SOUS_SEUIL: 0, NORMAL: 0, SURSTOCK: 0, SANS_STOCK: 0, quantite: 0, cmm: 0, perimee: 0, proche: 0 };
}
function arrondi(n) {
  return Math.round(n * 100) / 100;
}
function pourcent(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

async function carteStocks(req, res) {
  try {
    const { etablissementId, role } = req.utilisateur;
    const moi = !etablissementId && role === "ADMIN" ? {} : await prisma.etablissement.findUnique({
      where: { id: etablissementId },
      include: { moughataa: true },
    });
    if (!moi) return res.status(404).json({ erreur: "Etablissement introuvable." });

    const where = { type: "FORMATION_SANITAIRE", actif: true };
    let portee, libellePortee;
    if (ROLES_NATIONAL.includes(role)) {
      portee = "NATIONAL";
      libellePortee = "Tout le pays";
    } else if (ROLES_DRS.includes(role)) {
      const drsId = moi.drsId || (moi.moughataa && moi.moughataa.drsId) || null;
      if (!drsId) return res.status(403).json({ erreur: "Aucune wilaya associ\u00e9e \u00e0 ton compte." });
      const drs = await prisma.drs.findUnique({ where: { id: drsId } });
      where.moughataa = { drsId };
      portee = "WILAYA";
      libellePortee = "Wilaya : " + (drs ? drs.nom : "");
    } else if (ROLES_MOUGHATAA.includes(role)) {
      if (!moi.moughataaId) return res.status(403).json({ erreur: "Aucune moughataa associ\u00e9e \u00e0 ton compte." });
      where.moughataaId = moi.moughataaId;
      portee = "MOUGHATAA";
      libellePortee = "Moughataa : " + (moi.moughataa ? moi.moughataa.nom : "");
    } else {
      return res.status(403).json({ erreur: "Cette vue n'est pas disponible pour ton r\u00f4le." });
    }

    // Produits proposes (le GAS Programme national ne voit que ceux de son programme)
    const whereProduit = role === "GAS_PROGRAMME_NATIONAL" && moi.programmeId ? { programmeId: moi.programmeId } : {};
    const produits = await prisma.produit.findMany({ where: whereProduit, orderBy: { nom: "asc" }, select: { id: true, nom: true } });

    const formations = await prisma.etablissement.findMany({
      where,
      select: {
        id: true, nom: true, niveau: true, latitude: true, longitude: true, moughataaId: true,
        moughataa: { select: { nom: true, drs: { select: { nom: true } } } },
      },
      orderBy: { nom: "asc" },
    });
    const ids = formations.map((f) => f.id);

    // Produit choisi : celui demande, sinon celui qui a le plus de lignes de stock dans la portee
    let produitId = req.query.produitId && produits.some((p) => p.id === req.query.produitId) ? req.query.produitId : null;
    if (!produitId && produits.length) {
      const groupes = await prisma.stock.groupBy({
        by: ["produitId"],
        where: { etablissementId: { in: ids }, produitId: { in: produits.map((p) => p.id) } },
        _count: { _all: true },
      });
      groupes.sort((a, b) => b._count._all - a._count._all);
      produitId = groupes.length ? groupes[0].produitId : produits[0].id;
    }

    const stocks = produitId
      ? await prisma.stock.findMany({ where: { produitId, etablissementId: { in: ids } }, select: { etablissementId: true, quantiteTotale: true, statut: true } })
      : [];
    const stockParEtab = new Map(stocks.map((s) => [s.etablissementId, s]));

    // CMM par formation (sorties par dispensation des 6 derniers mois / 6)
    const cmmParEtab = new Map();
    const perimeeParEtab = new Map();
    const procheParEtab = new Map();
    if (produitId && ids.length) {
      const ilYA6Mois = new Date();
      ilYA6Mois.setMonth(ilYA6Mois.getMonth() - 6);
      const annuleesIds = await idsDispensationsAnnulees();
      const mouvements = await prisma.mouvementStock.findMany({
        where: {
          type: "SORTIE",
          referenceType: "DISPENSATION",
          ...(annuleesIds.length > 0 ? { OR: [{ referenceId: null }, { referenceId: { notIn: annuleesIds } }] } : {}),
          dateMouvement: { gte: ilYA6Mois },
          lot: { etablissementId: { in: ids }, produitId },
        },
        select: { quantite: true, lot: { select: { etablissementId: true } } },
      });
      for (const m of mouvements) {
        const e = m.lot.etablissementId;
        cmmParEtab.set(e, (cmmParEtab.get(e) || 0) + m.quantite);
      }
      const maintenant = new Date();
      const limite = new Date(maintenant.getTime() + JOURS_PEREMPTION * 24 * 3600 * 1000);
      const lots = await prisma.lot.findMany({
        where: { etablissementId: { in: ids }, produitId, quantite: { gt: 0 }, datePeremption: { lt: limite } },
        select: { etablissementId: true, quantite: true, datePeremption: true },
      });
      for (const l of lots) {
        const cible = l.datePeremption < maintenant ? perimeeParEtab : procheParEtab;
        cible.set(l.etablissementId, (cible.get(l.etablissementId) || 0) + l.quantite);
      }
    }

    // Performance de gestion : DMM des depots de moughataa (sorties par BL) pour le produit choisi
    const performanceDisponible = portee === "NATIONAL" || portee === "WILAYA" || portee === "MOUGHATAA";
    const dmmParMoughataa = new Map();
    const avecDepot = new Set();
    if (performanceDisponible && produitId) {
      const whereDepot = { type: "GAS_MOUGHATAA" };
      if (portee === "WILAYA") whereDepot.drsId = where.moughataa.drsId;
      else if (portee === "MOUGHATAA") whereDepot.moughataaId = where.moughataaId;
      const depots = await prisma.etablissement.findMany({ where: whereDepot, select: { id: true, moughataaId: true } });
      const moughataaDuDepot = new Map(depots.map((d) => [d.id, d.moughataaId]));
      depots.forEach((d) => avecDepot.add(d.moughataaId));
      if (depots.length) {
        const ilYA6MoisBl = new Date();
        ilYA6MoisBl.setMonth(ilYA6MoisBl.getMonth() - 6);
        const sortiesBl = await prisma.mouvementStock.findMany({
          where: {
            type: "SORTIE",
            referenceType: "BL",
            dateMouvement: { gte: ilYA6MoisBl },
            lot: { etablissementId: { in: depots.map((d) => d.id) }, produitId },
          },
          select: { quantite: true, lot: { select: { etablissementId: true } } },
        });
        for (const m of sortiesBl) {
          const mg = moughataaDuDepot.get(m.lot.etablissementId);
          dmmParMoughataa.set(mg, (dmmParMoughataa.get(mg) || 0) + m.quantite);
        }
      }
    }

    const parWilaya = new Map();
    const parMoughataa = new Map();
    const totaux = compteurVide();
    let avecGps = 0;
    const lignes = formations.map((f) => {
      const s = stockParEtab.get(f.id);
      const statut = s ? s.statut : "SANS_STOCK";
      const quantite = s ? s.quantiteTotale : 0;
      const cmm = arrondi((cmmParEtab.get(f.id) || 0) / 6);
      const couverture = cmm > 0 ? arrondi(quantite / cmm) : null;
      const perimee = perimeeParEtab.get(f.id) || 0;
      const proche = procheParEtab.get(f.id) || 0;
      const wilaya = (f.moughataa && f.moughataa.drs && f.moughataa.drs.nom) || "Sans wilaya";
      const moughataa = (f.moughataa && f.moughataa.nom) || "Sans moughataa";
      const gps = f.latitude !== null && f.latitude !== undefined && f.longitude !== null && f.longitude !== undefined;
      if (gps) avecGps++;

      totaux.total++;
      totaux[statut]++;
      totaux.quantite += quantite; totaux.cmm += cmm; totaux.perimee += perimee; totaux.proche += proche;
      if (!parWilaya.has(wilaya)) parWilaya.set(wilaya, { nom: wilaya, ...compteurVide(), sommeLat: 0, sommeLon: 0, nbGps: 0 });
      const w = parWilaya.get(wilaya);
      w.total++;
      w[statut]++;
      w.quantite += quantite; w.cmm += cmm; w.perimee += perimee; w.proche += proche;
      if (gps) { w.sommeLat += f.latitude; w.sommeLon += f.longitude; w.nbGps++; }
      const cleM = wilaya + "|" + (f.moughataaId || moughataa);
      if (!parMoughataa.has(cleM)) parMoughataa.set(cleM, { id: f.moughataaId || null, nom: moughataa, wilaya, ...compteurVide() });
      const m = parMoughataa.get(cleM);
      m.total++;
      m[statut]++;
      m.quantite += quantite; m.cmm += cmm; m.perimee += perimee; m.proche += proche;

      return {
        id: f.id, nom: f.nom, niveau: f.niveau, wilaya, moughataa,
        latitude: gps ? f.latitude : null, longitude: gps ? f.longitude : null,
        statut, quantite: s ? s.quantiteTotale : null,
        cmm, couverture, perimee, proche,
      };
    });

    const wilayas = [...parWilaya.values()]
      .map((w) => ({
        nom: w.nom, total: w.total, RUPTURE: w.RUPTURE, SOUS_SEUIL: w.SOUS_SEUIL, NORMAL: w.NORMAL, SURSTOCK: w.SURSTOCK, SANS_STOCK: w.SANS_STOCK,
        pctRupture: pourcent(w.RUPTURE, w.total),
        quantite: w.quantite, cmm: arrondi(w.cmm), perimee: w.perimee, proche: w.proche,
        couverture: w.cmm > 0 ? arrondi(w.quantite / w.cmm) : null,
        centre: w.nbGps ? { latitude: w.sommeLat / w.nbGps, longitude: w.sommeLon / w.nbGps } : null,
      }))
      .sort((a, b) => a.nom.localeCompare(b.nom));
    const moughataas = [...parMoughataa.values()]
      .map((m) => {
        const dmm = performanceDisponible && avecDepot.has(m.id) ? arrondi((dmmParMoughataa.get(m.id) || 0) / 6) : null;
        const ecart = dmm === null ? null : arrondi(dmm - m.cmm);
        return {
          ...m, cmm: arrondi(m.cmm), pctRupture: pourcent(m.RUPTURE, m.total),
          couverture: m.cmm > 0 ? arrondi(m.quantite / m.cmm) : null,
          dmm, ecart, ecartPct: ecart !== null && m.cmm > 0 ? Math.round((ecart / m.cmm) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => a.wilaya.localeCompare(b.wilaya) || a.nom.localeCompare(b.nom));
    for (const w of wilayas) {
      const liste = moughataas.filter((m) => m.wilaya === w.nom && m.dmm !== null);
      w.dmm = liste.length ? arrondi(liste.reduce((a, m) => a + m.dmm, 0)) : null;
      const cmmDepots = liste.reduce((a, m) => a + m.cmm, 0);
      w.ecart = w.dmm === null ? null : arrondi(w.dmm - cmmDepots);
      w.ecartPct = w.ecart !== null && cmmDepots > 0 ? Math.round((w.ecart / cmmDepots) * 1000) / 10 : null;
    }

    return res.json({
      portee,
      libellePortee,
      produits,
      produitId,
      statuts: STATUTS,
      joursPeremption: JOURS_PEREMPTION,
      performanceDisponible,
      totaux: { ...totaux, cmm: arrondi(totaux.cmm), couverture: totaux.cmm > 0 ? arrondi(totaux.quantite / totaux.cmm) : null, avecGps, sansGps: totaux.total - avecGps },
      wilayas,
      moughataas,
      formations: lignes,
    });
  } catch (err) {
    console.error("Carte du stock :", err.message);
    return res.status(500).json({ erreur: "Impossible de calculer la carte du stock." + (req.utilisateur && req.utilisateur.role === "ADMIN" ? " Detail : " + err.message : "") });
  }
}

module.exports = { carteStocks };