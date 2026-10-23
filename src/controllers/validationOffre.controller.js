const prisma = require("../config/prisma");

// ---------------------------------------------------------------------------
// Validation de l'offre de service par le Medecin chef de la Moughataa (MCM).
//
//   GET /offre-validation/fosas
//         FOSA actives de sa Moughataa + nombre de reponses en attente
//   GET /offre-validation/fosas/:etablissementId/services
//         reponses d'une FOSA : declaree, officielle, statut
//   PUT /offre-validation/fosas/:etablissementId/services
//         { decisions: [{ serviceId, valeur: true|false }, ...] }
//
// Regles :
//   - seul le MEDECIN_CHEF_MOUGHATAA, et uniquement pour les FOSA actives de SA Moughataa ;
//   - une decision fixe la valeur OFFICIELLE (valeurValidee), qui est la seule comptee
//     dans les indicateurs ; "valider" = confirmer la reponse de la FOSA, "changer" = l'autre valeur ;
//   - une reponse est EN_ATTENTE si elle n'a jamais ete traitee ou si la FOSA l'a modifiee
//     apres la decision ; VALIDE si la decision confirme la reponse ; CORRIGE sinon ;
//   - le MCM n'agit que sur des services deja renseignes par la FOSA.
// ---------------------------------------------------------------------------

// Renvoie { moughataaId, nom } ou repond 403 et renvoie null.
async function moughataaDuMcm(req, res) {
  const { role, etablissementId } = req.utilisateur;
  if (role !== "MEDECIN_CHEF_MOUGHATAA" || !etablissementId) {
    res.status(403).json({ erreur: "Seul le Médecin chef de la Moughataa peut valider l'offre de service." });
    return null;
  }
  const etab = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    select: { actif: true, moughataaId: true, moughataa: { select: { nom: true } } },
  });
  if (!etab || !etab.actif || !etab.moughataaId) {
    res.status(403).json({ erreur: "Ton compte n'est rattaché à aucune Moughataa active." });
    return null;
  }
  return { moughataaId: etab.moughataaId, nom: (etab.moughataa && etab.moughataa.nom) || "Moughataa" };
}

// Charge la FOSA demandee et verifie qu'elle est active et dans la Moughataa du MCM.
async function fosaDansMoughataa(moughataaId, etablissementId, res) {
  const fosa = await prisma.etablissement.findFirst({
    where: { id: etablissementId, type: "FORMATION_SANITAIRE", actif: true, moughataaId },
    select: { id: true, nom: true, niveau: true },
  });
  if (!fosa) {
    res.status(404).json({ erreur: "Formation sanitaire introuvable dans ta Moughataa." });
    return null;
  }
  return fosa;
}

function statutReponse(o) {
  if (!o.valideeLe || o.updatedAt > o.valideeLe) return "EN_ATTENTE";
  return o.valeurValidee === o.offert ? "VALIDE" : "CORRIGE";
}

// GET /offre-validation/fosas
async function listerFosas(req, res) {
  try {
    const mcm = await moughataaDuMcm(req, res);
    if (!mcm) return;

    const fosas = await prisma.etablissement.findMany({
      where: { type: "FORMATION_SANITAIRE", actif: true, moughataaId: mcm.moughataaId },
      select: { id: true, nom: true, niveau: true },
      orderBy: { nom: "asc" },
    });
    const ids = fosas.map((f) => f.id);
    const offres = ids.length
      ? await prisma.offreService.findMany({
          where: { etablissementId: { in: ids }, service: { actif: true } },
          select: { etablissementId: true, offert: true, valeurValidee: true, valideeLe: true, updatedAt: true },
        })
      : [];

    const bilan = new Map(ids.map((id) => [id, { renseignes: 0, enAttente: 0, valides: 0, corriges: 0 }]));
    for (const o of offres) {
      const b = bilan.get(o.etablissementId);
      b.renseignes += 1;
      const statut = statutReponse(o);
      if (statut === "EN_ATTENTE") b.enAttente += 1;
      else if (statut === "VALIDE") b.valides += 1;
      else b.corriges += 1;
    }

    const lignes = fosas
      .map((f) => ({ id: f.id, nom: f.nom, niveau: f.niveau || null, ...bilan.get(f.id) }))
      .sort((a, b) => b.enAttente - a.enAttente || a.nom.localeCompare(b.nom, "fr"));

    return res.json({
      moughataa: mcm.nom,
      totalEnAttente: lignes.reduce((somme, l) => somme + l.enAttente, 0),
      fosas: lignes,
    });
  } catch (erreur) {
    console.error("Erreur lors de la lecture des FOSA à valider :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du chargement des formations sanitaires." });
  }
}

// GET /offre-validation/fosas/:etablissementId/services
async function servicesDeLaFosa(req, res) {
  try {
    const mcm = await moughataaDuMcm(req, res);
    if (!mcm) return;
    const fosa = await fosaDansMoughataa(mcm.moughataaId, req.params.etablissementId, res);
    if (!fosa) return;

    const [services, offres] = await Promise.all([
      prisma.serviceProgramme.findMany({
        where: { actif: true },
        orderBy: { ordre: "asc" },
        include: { programme: { select: { code: true, nom: true } } },
      }),
      prisma.offreService.findMany({
        where: { etablissementId: fosa.id },
        select: { serviceId: true, offert: true, valeurValidee: true, valideeLe: true, updatedAt: true },
      }),
    ]);
    const parService = new Map(offres.map((o) => [o.serviceId, o]));

    const lignes = services.map((s) => {
      const o = parService.get(s.id);
      return {
        serviceId: s.id,
        nom: s.nom,
        groupe: s.groupe || s.programme.nom,
        programme: { code: s.programme.code, nom: s.programme.nom },
        poids: s.poids,
        renseigne: !!o,
        declare: o ? o.offert : null,
        officiel: o ? o.valeurValidee : null,
        statut: o ? statutReponse(o) : null,
        misAJourLe: o ? o.updatedAt : null,
        valideeLe: o ? o.valideeLe : null,
      };
    });

    return res.json({ fosa, services: lignes });
  } catch (erreur) {
    console.error("Erreur lors de la lecture des services d'une FOSA :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du chargement des services." });
  }
}

// PUT /offre-validation/fosas/:etablissementId/services
// Body : { decisions: [{ serviceId, valeur: true|false }, ...] }
async function decider(req, res) {
  try {
    const mcm = await moughataaDuMcm(req, res);
    if (!mcm) return;
    const fosa = await fosaDansMoughataa(mcm.moughataaId, req.params.etablissementId, res);
    if (!fosa) return;

    const { decisions } = req.body || {};
    if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > 100) {
      return res.status(400).json({ erreur: "Liste de décisions requise (1 à 100 éléments)." });
    }
    const vus = new Set();
    for (const d of decisions) {
      if (!d || typeof d.serviceId !== "string" || typeof d.valeur !== "boolean") {
        return res.status(400).json({ erreur: "Chaque décision doit avoir un identifiant de service et une valeur oui ou non." });
      }
      if (vus.has(d.serviceId)) {
        return res.status(400).json({ erreur: "Un service est présent deux fois dans la liste." });
      }
      vus.add(d.serviceId);
    }

    // Seuls des services deja renseignes par la FOSA, et encore actifs.
    const renseignes = await prisma.offreService.findMany({
      where: { etablissementId: fosa.id, serviceId: { in: [...vus] }, service: { actif: true } },
      select: { serviceId: true },
    });
    if (renseignes.length !== vus.size) {
      return res.status(400).json({ erreur: "Un des services n'a pas encore été renseigné par la FOSA ou n'est plus actif." });
    }

    const { utilisateurId } = req.utilisateur;
    const maintenant = new Date();
    await prisma.$transaction(
      decisions.map((d) =>
        prisma.offreService.update({
          where: { serviceId_etablissementId: { serviceId: d.serviceId, etablissementId: fosa.id } },
          data: { valeurValidee: d.valeur, valideeParId: utilisateurId, valideeLe: maintenant, updatedAt: maintenant },
        })
      )
    );

    console.log(`[VALIDATION-OFFRE] ${maintenant.toISOString()} — MCM ${utilisateurId} (${mcm.nom}) : ${decisions.length} décision(s) pour ${fosa.nom}`);
    return res.json({ message: "Décisions enregistrées.", enregistrees: decisions.length });
  } catch (erreur) {
    console.error("Erreur lors de l'enregistrement des décisions de validation :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de l'enregistrement des décisions." });
  }
}

module.exports = { listerFosas, servicesDeLaFosa, decider };