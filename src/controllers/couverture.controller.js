const prisma = require("../config/prisma");

// ---------------------------------------------------------------------------
// Indicateurs de couverture de l'offre de service (LECTURE SEULE).
//
//   GET /couverture-offre              (optionnel : ?programme=CODE)
//
// Pour chaque service actif, deux indicateurs de couverture :
//   1. parmi les FOSA ELIGIBLES  = FOSA qui offrent le service / FOSA eligibles
//   2. parmi le TOTAL des FOSA   = FOSA qui offrent le service / total des FOSA
// calcules au niveau national, par DRS et par Moughataa ; plus, pour chaque
// FOSA, le nombre de services offerts rapporte aux services eligibles et au
// total des services.
//
// Regles :
//   - une FOSA desactivee est consideree comme supprimee : elle n'entre dans
//     aucun denominateur ;
//   - seules les FOSA eligibles comptent dans le numerateur ; les FOSA qui
//     offrent un service sans y etre eligibles sont comptees a part ;
//   - un service jamais renseigne par une FOSA eligible est "non renseigne".
//
// Perimetre :
//   - ADMIN, AUDITEUR : national, tous les programmes ;
//   - GAS_PROGRAMME_NATIONAL : national, uniquement son programme ;
//   - GESTIONNAIRE_DRS, DIRECTEUR_DRS : leur DRS ;
//   - GAS_MOUGHATAA, MEDECIN_CHEF_MOUGHATAA : leur Moughataa ;
//   - les autres roles : refuses.
// ---------------------------------------------------------------------------

const ROLES_DRS = ["GESTIONNAIRE_DRS", "DIRECTEUR_DRS"];
const ROLES_MOUGHATAA = ["GAS_MOUGHATAA", "MEDECIN_CHEF_MOUGHATAA"];

function pourcentage(numerateur, denominateur) {
  if (!denominateur) return null;
  return Math.round((numerateur * 1000) / denominateur) / 10;
}

// Renvoie { niveau, libelle, programmeId, drsId, moughataaId } ou repond 403 et renvoie null.
async function perimetreCouverture(req, res) {
  const { role, etablissementId } = req.utilisateur;

  if (role === "ADMIN" || role === "AUDITEUR") {
    return { niveau: "NATIONAL", libelle: "National", programmeId: null, drsId: null, moughataaId: null };
  }

  const roleAutorise = role === "GAS_PROGRAMME_NATIONAL" || ROLES_DRS.includes(role) || ROLES_MOUGHATAA.includes(role);
  if (!roleAutorise || !etablissementId) {
    res.status(403).json({ erreur: "Ton role n'a pas acces aux indicateurs de couverture." });
    return null;
  }

  const etab = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    select: {
      actif: true,
      programmeId: true,
      drsId: true,
      drs: { select: { nom: true } },
      moughataaId: true,
      moughataa: { select: { nom: true, drsId: true, drs: { select: { nom: true } } } },
    },
  });
  if (!etab || !etab.actif) {
    res.status(403).json({ erreur: "Ton etablissement n'est pas actif." });
    return null;
  }

  if (role === "GAS_PROGRAMME_NATIONAL") {
    if (!etab.programmeId) {
      res.status(403).json({ erreur: "Ton compte n'est rattache a aucun programme." });
      return null;
    }
    return { niveau: "NATIONAL", libelle: "National", programmeId: etab.programmeId, drsId: null, moughataaId: null };
  }

  if (ROLES_DRS.includes(role)) {
    const drsId = etab.drsId || (etab.moughataa && etab.moughataa.drsId) || null;
    if (!drsId) {
      res.status(403).json({ erreur: "Ton compte n'est rattache a aucune DRS." });
      return null;
    }
    const nom = (etab.drs && etab.drs.nom) || (etab.moughataa && etab.moughataa.drs && etab.moughataa.drs.nom) || "DRS";
    return { niveau: "DRS", libelle: nom, programmeId: null, drsId, moughataaId: null };
  }

  if (!etab.moughataaId) {
    res.status(403).json({ erreur: "Ton compte n'est rattache a aucune Moughataa." });
    return null;
  }
  return {
    niveau: "MOUGHATAA",
    libelle: (etab.moughataa && etab.moughataa.nom) || "Moughataa",
    programmeId: null,
    drsId: null,
    moughataaId: etab.moughataaId,
  };
}

// GET /couverture-offre
async function couverture(req, res) {
  try {
    const perimetre = await perimetreCouverture(req, res);
    if (!perimetre) return;

    const whereService = { actif: true };
    if (perimetre.programmeId) whereService.programmeId = perimetre.programmeId;
    const codeProgramme = typeof req.query.programme === "string" ? req.query.programme.trim() : "";
    if (codeProgramme) whereService.programme = { code: codeProgramme };

    const [services, fosasBrutes] = await Promise.all([
      prisma.serviceProgramme.findMany({
        where: whereService,
        orderBy: { ordre: "asc" },
        include: { programme: { select: { id: true, code: true, nom: true } } },
      }),
      prisma.etablissement.findMany({
        where: { type: "FORMATION_SANITAIRE", actif: true },
        select: {
          id: true,
          nom: true,
          niveau: true,
          drsId: true,
          drs: { select: { nom: true } },
          moughataaId: true,
          moughataa: { select: { nom: true, drsId: true, drs: { select: { nom: true } } } },
        },
      }),
    ]);

    // Restriction geographique (DRS directe ou via la Moughataa).
    const fosas = fosasBrutes
      .map((f) => ({
        id: f.id,
        nom: f.nom,
        niveau: f.niveau || null,
        drsId: f.drsId || (f.moughataa && f.moughataa.drsId) || null,
        drs: (f.drs && f.drs.nom) || (f.moughataa && f.moughataa.drs && f.moughataa.drs.nom) || null,
        moughataaId: f.moughataaId || null,
        moughataa: (f.moughataa && f.moughataa.nom) || null,
      }))
      .filter((f) => {
        if (perimetre.drsId) return f.drsId === perimetre.drsId;
        if (perimetre.moughataaId) return f.moughataaId === perimetre.moughataaId;
        return true;
      });

    if (services.length === 0) {
      return res.json({
        portee: { niveau: perimetre.niveau, libelle: perimetre.libelle },
        totalFosa: fosas.length,
        nbServices: 0,
        services: [],
        fosas: [],
        genereLe: new Date().toISOString(),
      });
    }

    const serviceIds = services.map((s) => s.id);
    const idsFosa = new Set(fosas.map((f) => f.id));

    const [eligibilites, offres] = await Promise.all([
      prisma.eligibiliteService.findMany({
        where: { serviceId: { in: serviceIds } },
        select: { serviceId: true, etablissementId: true },
      }),
      prisma.offreService.findMany({
        where: { serviceId: { in: serviceIds } },
        select: { serviceId: true, etablissementId: true, offert: true },
      }),
    ]);

    // serviceId -> Set(fosaId eligibles)
    const eligibles = new Map(serviceIds.map((id) => [id, new Set()]));
    for (const e of eligibilites) {
      if (idsFosa.has(e.etablissementId)) eligibles.get(e.serviceId).add(e.etablissementId);
    }
    // serviceId -> Map(fosaId -> offert)
    const reponses = new Map(serviceIds.map((id) => [id, new Map()]));
    for (const o of offres) {
      if (idsFosa.has(o.etablissementId)) reponses.get(o.serviceId).set(o.etablissementId, o.offert);
    }

    // Regroupements geographiques.
    const parDrs = new Map();
    const parMoughataa = new Map();
    for (const f of fosas) {
      const cleDrs = f.drs || "Sans DRS";
      if (!parDrs.has(cleDrs)) parDrs.set(cleDrs, { nom: cleDrs, fosas: [] });
      parDrs.get(cleDrs).fosas.push(f);

      const cleMoughataa = f.moughataaId || "__sans_moughataa__";
      if (!parMoughataa.has(cleMoughataa)) {
        parMoughataa.set(cleMoughataa, { nom: f.moughataa || "Sans Moughataa", drs: f.drs || "Sans DRS", fosas: [] });
      }
      parMoughataa.get(cleMoughataa).fosas.push(f);
    }

    // Calcul des deux indicateurs pour un service et un ensemble de FOSA.
    function calculer(serviceId, ensemble) {
      const setEligibles = eligibles.get(serviceId);
      const mapReponses = reponses.get(serviceId);
      let nbEligibles = 0;
      let nbOffrent = 0;
      let nbNonRenseignes = 0;
      let nbOffrentHorsEligibilite = 0;
      for (const f of ensemble) {
        const estEligible = setEligibles.has(f.id);
        const reponse = mapReponses.get(f.id);
        if (estEligible) {
          nbEligibles += 1;
          if (reponse === true) nbOffrent += 1;
          else if (reponse === undefined) nbNonRenseignes += 1;
        } else if (reponse === true) {
          nbOffrentHorsEligibilite += 1;
        }
      }
      return {
        totalFosa: ensemble.length,
        eligibles: nbEligibles,
        offrent: nbOffrent,
        nonRenseignes: nbNonRenseignes,
        offrentHorsEligibilite: nbOffrentHorsEligibilite,
        couvertureEligibles: pourcentage(nbOffrent, nbEligibles),
        couvertureTotale: pourcentage(nbOffrent, ensemble.length),
      };
    }

    const listeDrs = [...parDrs.values()].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    const listeMoughataas = [...parMoughataa.values()].sort(
      (a, b) => a.drs.localeCompare(b.drs, "fr") || a.nom.localeCompare(b.nom, "fr")
    );

    const resultatServices = services.map((s) => ({
      id: s.id,
      nom: s.nom,
      groupe: s.groupe || s.programme.nom,
      programme: { code: s.programme.code, nom: s.programme.nom },
      ciblePct: s.ciblePct,
      national: calculer(s.id, fosas),
      parDrs: listeDrs.map((d) => ({ nom: d.nom, ...calculer(s.id, d.fosas) })),
      parMoughataa: listeMoughataas.map((m) => ({ nom: m.nom, drs: m.drs, ...calculer(s.id, m.fosas) })),
    }));

    // Niveau FOSA : services offerts rapportes aux services eligibles et au total des services.
    const nbServices = services.length;
    const resultatFosas = fosas
      .map((f) => {
        let nbEligibles = 0;
        let nbOfferts = 0;
        for (const s of services) {
          if (eligibles.get(s.id).has(f.id)) {
            nbEligibles += 1;
            if (reponses.get(s.id).get(f.id) === true) nbOfferts += 1;
          }
        }
        return {
          id: f.id,
          nom: f.nom,
          drs: f.drs,
          moughataa: f.moughataa,
          niveau: f.niveau,
          servicesEligibles: nbEligibles,
          servicesOfferts: nbOfferts,
          totalServices: nbServices,
          couvertureEligibles: pourcentage(nbOfferts, nbEligibles),
          couvertureTotale: pourcentage(nbOfferts, nbServices),
        };
      })
      .sort(
        (a, b) =>
          (a.drs || "").localeCompare(b.drs || "", "fr") ||
          (a.moughataa || "").localeCompare(b.moughataa || "", "fr") ||
          a.nom.localeCompare(b.nom, "fr")
      );

    return res.json({
      portee: { niveau: perimetre.niveau, libelle: perimetre.libelle },
      totalFosa: fosas.length,
      nbServices,
      services: resultatServices,
      fosas: resultatFosas,
      genereLe: new Date().toISOString(),
    });
  } catch (erreur) {
    console.error("Erreur lors du calcul de la couverture de l'offre :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du calcul des indicateurs de couverture." });
  }
}

module.exports = { couverture };