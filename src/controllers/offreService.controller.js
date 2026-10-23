const prisma = require("../config/prisma");

// ---------------------------------------------------------------------------
// Offre de service par programme — saisie par la formation sanitaire (FOSA).
//
//   GET /offre-service/mes-services   services à déclarer + état actuel
//   PUT /offre-service/mes-services   enregistre « offert / non offert »
//
// Garde-fous :
//   - seul un compte FOSA peut déclarer, et seulement pour SON établissement
//     (déduit du compte connecté, jamais du corps de la requête) ;
//   - un service jamais renseigné reste « non renseigné » (offert = null) ;
//   - aucun service n'est supprimé ni créé ici : on ne fait que renseigner l'offre.
// ---------------------------------------------------------------------------

// Établissement FOSA du compte connecté (ou réponse d'erreur).
async function fosaDuCompte(req, res) {
  const { etablissementId, role } = req.utilisateur;
  if (role !== "FORMATION_SANITAIRE" || !etablissementId) {
    res.status(403).json({ erreur: "Seul un compte de formation sanitaire peut déclarer ses services." });
    return null;
  }
  const etablissement = await prisma.etablissement.findUnique({
    where: { id: etablissementId },
    select: { id: true, nom: true, type: true, actif: true },
  });
  if (!etablissement || etablissement.type !== "FORMATION_SANITAIRE" || !etablissement.actif) {
    res.status(403).json({ erreur: "Ton établissement n'est pas une formation sanitaire active." });
    return null;
  }
  return etablissement;
}

// Statut d'une reponse : EN_ATTENTE (jamais traitee, ou modifiee apres la decision du MCM),
// VALIDE (la decision confirme la reponse) ou CORRIGE (decision differente).
function statutReponse(o) {
  if (!o.valideeLe || o.updatedAt > o.valideeLe) return "EN_ATTENTE";
  return o.valeurValidee === o.offert ? "VALIDE" : "CORRIGE";
}

function pourcentage(numerateur, denominateur) {
  return denominateur > 0 ? Math.round((numerateur * 1000) / denominateur) / 10 : null;
}

// c = { num: points des services offerts (eligibles), el: points des services eligibles, tot: points de tous les services }
function calculerScore(c) {
  return {
    points: c.num,
    pointsEligibles: c.el,
    pointsTotal: c.tot,
    couvertureEligibles: pourcentage(c.num, c.el),
    couvertureTotale: pourcentage(c.num, c.tot),
  };
}

// GET /offre-service/mes-services
async function mesServices(req, res) {
  try {
    const etablissement = await fosaDuCompte(req, res);
    if (!etablissement) return;

    const [services, offres, eligibilites] = await Promise.all([
      prisma.serviceProgramme.findMany({
        where: { actif: true },
        orderBy: { ordre: "asc" },
        include: { programme: { select: { id: true, code: true, nom: true } } },
      }),
      prisma.offreService.findMany({
        where: { etablissementId: etablissement.id },
        select: { serviceId: true, offert: true, valeurValidee: true, valideeLe: true, updatedAt: true },
      }),
      prisma.eligibiliteService.findMany({
        where: { etablissementId: etablissement.id },
        select: { serviceId: true },
      }),
    ]);

    const offreParService = new Map(offres.map((o) => [o.serviceId, o]));
    const eligibleIds = new Set(eligibilites.map((e) => e.serviceId));
    const cumul = { off: { num: 0, el: 0, tot: 0 }, prov: { num: 0, el: 0, tot: 0 } };

    // Regroupement programme > groupe > services, dans l'ordre d'affichage.
    const programmes = [];
    for (const s of services) {
      let programme = programmes.find((p) => p.code === s.programme.code);
      if (!programme) {
        programme = { code: s.programme.code, nom: s.programme.nom, groupes: [] };
        programmes.push(programme);
      }
      const nomGroupe = s.groupe || s.programme.nom;
      let groupe = programme.groupes.find((g) => g.groupe === nomGroupe);
      if (!groupe) {
        groupe = { groupe: nomGroupe, services: [] };
        programme.groupes.push(groupe);
      }
      const offre = offreParService.get(s.id);
      const poids = s.poids || 1;
      const eligible = eligibleIds.has(s.id);
      const statut = offre ? statutReponse(offre) : null;
      const officiel = offre ? offre.valeurValidee : null;
      const provisoire = offre ? (statut === "EN_ATTENTE" ? offre.offert : officiel) : false;
      cumul.off.tot += poids;
      cumul.prov.tot += poids;
      if (eligible) {
        cumul.off.el += poids;
        cumul.prov.el += poids;
        if (officiel === true) cumul.off.num += poids;
        if (provisoire === true) cumul.prov.num += poids;
      }
      groupe.services.push({
        id: s.id,
        nom: s.nom,
        dependance: s.dependance,
        offert: offre ? offre.offert : null, // null = non renseigné
        misAJourLe: offre ? offre.updatedAt : null,
        poids,
        eligible,
        statut,
        officiel,
      });
    }

    return res.json({
      etablissement: { id: etablissement.id, nom: etablissement.nom },
      programmes,
      scores: { officiel: calculerScore(cumul.off), provisoire: calculerScore(cumul.prov) },
    });
  } catch (erreur) {
    console.error("Erreur lors de la lecture des services de la FOSA :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du chargement des services." });
  }
}

// PUT /offre-service/mes-services
// Body : { services: [{ serviceId, offert: true|false }, ...] }
async function enregistrerMesServices(req, res) {
  try {
    const etablissement = await fosaDuCompte(req, res);
    if (!etablissement) return;

    const { services } = req.body || {};
    if (!Array.isArray(services) || services.length === 0 || services.length > 100) {
      return res.status(400).json({ erreur: "Liste de services requise (1 à 100 éléments)." });
    }

    const vus = new Set();
    for (const s of services) {
      if (!s || typeof s.serviceId !== "string" || typeof s.offert !== "boolean") {
        return res.status(400).json({ erreur: "Chaque service doit avoir un identifiant et une valeur « offert » oui ou non." });
      }
      if (vus.has(s.serviceId)) {
        return res.status(400).json({ erreur: "Un service est présent deux fois dans la liste." });
      }
      vus.add(s.serviceId);
    }

    // Tous les services doivent exister et être actifs.
    const existants = await prisma.serviceProgramme.findMany({
      where: { id: { in: [...vus] }, actif: true },
      select: { id: true },
    });
    if (existants.length !== vus.size) {
      return res.status(400).json({ erreur: "Un des services demandés n'existe pas ou n'est plus actif." });
    }

    const { utilisateurId } = req.utilisateur;
    await prisma.$transaction(
      services.map((s) =>
        prisma.offreService.upsert({
          where: { serviceId_etablissementId: { serviceId: s.serviceId, etablissementId: etablissement.id } },
          update: { offert: s.offert, declareParId: utilisateurId },
          create: {
            serviceId: s.serviceId,
            etablissementId: etablissement.id,
            offert: s.offert,
            declareParId: utilisateurId,
          },
        })
      )
    );

    console.log(`[OFFRE] ${new Date().toISOString()} — utilisateur ${utilisateurId} (${etablissement.nom}) : ${services.length} service(s) enregistré(s)`);
    return res.json({ message: "Services enregistrés.", enregistres: services.length });
  } catch (erreur) {
    console.error("Erreur lors de l'enregistrement des services de la FOSA :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de l'enregistrement des services." });
  }
}

module.exports = { mesServices, enregistrerMesServices };